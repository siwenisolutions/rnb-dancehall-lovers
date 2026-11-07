'use strict';
// Reads a public social media post from its link: the caption and its picture.
// Uses public routes only (TikTok's oEmbed, Instagram's embed page, and the
// Open Graph preview tags that public posts publish for link previews).
const sharp = require('sharp');

// Only these sites (and their image servers) are ever fetched.
const POST_HOSTS = /(^|\.)(instagram\.com|instagr\.am|tiktok\.com|facebook\.com|fb\.com|fb\.watch|threads\.net|x\.com|twitter\.com)$/i;
const IMAGE_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|ibyteimg\.com|byteimg\.com|tiktok\.com|twimg\.com|threads\.net|facebook\.com)$/i;
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class ImportError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function checkUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) throw new ImportError('Paste the link to your post first.');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let u;
  try { u = new URL(v); } catch { throw new ImportError("That doesn't look like a link. Copy it with the Share or Copy link button on the post."); }
  if (!POST_HOSTS.test(u.hostname)) throw new ImportError('Use a link from Instagram, TikTok or Facebook.');
  u.protocol = 'https:';
  return u;
}

// Fetch with a time limit, a size limit, and redirects only to allowed hosts.
async function safeFetch(url, { hosts, headers = {}, maxBytes = 3 * 1024 * 1024, asBuffer = false } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' || !hosts.test(current.hostname)) throw new ImportError('That link leads somewhere we cannot read.');
    const res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(9000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    if (!res.ok) return { status: res.status, url: current, body: null };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); break; }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    return { status: res.status, url: current, body: asBuffer ? buf : buf.toString('utf8'), type: res.headers.get('content-type') || '' };
  }
  throw new ImportError('That link redirects too many times.');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function metaTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  const c = tag.match(/content=["']([^"']*)["']/i) || tag.match(/content="([^"]*)"/i);
  return c ? decodeEntities(c[1]) : '';
}

// Instagram previews read: '123 likes, 4 comments - name on December 1, 2026: "the caption".'
function cleanInstagramDescription(d) {
  const m = d.match(/:\s*["“]([\s\S]*)["”]\s*\.?\s*$/);
  if (m) return m[1].trim();
  return d.replace(/^[\d.,KkMm]+\s+likes?,\s*[\d.,KkMm]+\s+comments?\s*-\s*/i, '').trim();
}

// The caption block on Instagram's public embed page.
function instagramEmbedCaption(html) {
  const start = html.search(/class=["']Caption["']/);
  if (start < 0) return '';
  let block = html.slice(start, start + 20000);
  const end = block.search(/<[a-z]+[^>]*class=["']CaptionComments["']|<\/div>\s*<\/div>/i);
  if (end > 0) block = block.slice(0, end);
  block = block.replace(/^[^>]*>/, '')
    .replace(/<a[^>]*class=["']CaptionUsername["'][^>]*>[\s\S]*?<\/a>/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(block).replace(/\n{3,}/g, '\n\n').trim();
}
function instagramEmbedImage(html) {
  const m = html.match(/<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]*>/i);
  if (!m) return '';
  const src = m[0].match(/src=["']([^"']+)["']/i);
  return src ? decodeEntities(src[1]) : '';
}

async function fromInstagram(u, log) {
  if (/\/stories\//.test(u.pathname)) {
    throw new ImportError("Instagram stories disappear and need a login, so they can't be read. Use the link to the post or reel instead, or paste the text below.");
  }
  const code = (u.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [])[1];
  let caption = '', image = '';
  if (code) {
    const embed = await safeFetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { hosts: POST_HOSTS, headers: { 'User-Agent': BROWSER_UA } });
    log.push(`ig-embed ${embed.status}`);
    if (embed.body) { caption = instagramEmbedCaption(embed.body); image = instagramEmbedImage(embed.body); }
  }
  if (!caption) {
    const page = await safeFetch(u.toString(), { hosts: POST_HOSTS, headers: { 'User-Agent': PREVIEW_UA } });
    log.push(`ig-page ${page.status}`);
    if (page.body) {
      caption = cleanInstagramDescription(metaTag(page.body, 'og:description') || metaTag(page.body, 'description'));
      image = image || metaTag(page.body, 'og:image');
    }
  }
  return { caption, image };
}

async function fromTikTok(u, log) {
  const o = await safeFetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u.toString())}`, { hosts: POST_HOSTS, headers: { 'User-Agent': BROWSER_UA } });
  log.push(`tt-oembed ${o.status}`);
  if (o.body) {
    try {
      const j = JSON.parse(o.body);
      if (j.title || j.thumbnail_url) return { caption: j.title || '', image: j.thumbnail_url || '' };
    } catch { /* fall through */ }
  }
  return fromPreviewTags(u, log);
}

async function fromPreviewTags(u, log) {
  const page = await safeFetch(u.toString(), { hosts: POST_HOSTS, headers: { 'User-Agent': PREVIEW_UA } });
  log.push(`og ${page.status}`);
  if (!page.body) return { caption: '', image: '' };
  const desc = metaTag(page.body, 'og:description') || metaTag(page.body, 'description');
  const title = metaTag(page.body, 'og:title');
  const caption = desc && desc.length >= title.length ? desc : (title || desc);
  return { caption, image: metaTag(page.body, 'og:image') };
}

// Downloads the post's picture and returns it as a small WebP data URL for the poster.
async function fetchPoster(imageUrl, log) {
  if (!imageUrl) return null;
  try {
    const r = await safeFetch(decodeEntities(imageUrl), { hosts: IMAGE_HOSTS, headers: { 'User-Agent': BROWSER_UA }, maxBytes: 12 * 1024 * 1024, asBuffer: true });
    log.push(`image ${r.status}`);
    if (!r.body || !r.body.length) return null;
    const out = await sharp(r.body).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch (e) {
    log.push(`image failed ${e.message}`);
    return null;
  }
}

async function importPost(rawUrl) {
  const u = checkUrl(rawUrl);
  const log = [];
  const host = u.hostname.toLowerCase();
  let source = 'facebook';
  let got;
  try {
    if (/instagram\.com$|instagr\.am$/.test(host)) { source = 'instagram'; got = await fromInstagram(u, log); }
    else if (/tiktok\.com$/.test(host)) { source = 'tiktok'; got = await fromTikTok(u, log); }
    else { source = /threads|x\.com|twitter/.test(host) ? 'social' : 'facebook'; got = await fromPreviewTags(u, log); }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    log.push(`error ${e.name}: ${e.message}`);
    got = { caption: '', image: '' };
  }
  const caption = (got.caption || '').trim();
  const poster = await fetchPoster(got.image, log);
  console.log(`[import] ${source} ${u.hostname}${u.pathname} -> caption ${caption.length} chars, poster ${poster ? 'yes' : 'no'} (${log.join(', ')})`);
  if (!caption && !poster) {
    throw new ImportError(`We couldn't read that post. It may be private, or ${source === 'instagram' ? 'Instagram' : 'the site'} may be hiding it from websites right now. Paste the caption below instead.`);
  }
  return { source, caption, poster };
}

module.exports = { importPost, cleanInstagramDescription, instagramEmbedCaption, instagramEmbedImage, metaTag, checkUrl, ImportError };

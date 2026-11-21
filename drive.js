'use strict';
// Reads photos from a Google Drive folder shared as "Anyone with the link".
// With GOOGLE_API_KEY set, the Drive API is used (any folder size). Without
// it, the folder's public embed page is read, which needs no setup.
// Photos are copied into the website (compressed), so the site never depends
// on Drive being reachable.

const API_KEY = process.env.GOOGLE_API_KEY || '';
// Overridable only for local tests.
const WEB = process.env.DRIVE_WEB_BASE || 'https://drive.google.com';
const API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const HOSTS = process.env.DRIVE_WEB_BASE
  ? /^(localhost|127\.0\.0\.1)$/
  : /(^|\.)(google\.com|googleusercontent\.com|googleapis\.com)$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif|tiff?|avif|bmp)$/i;
const OTHER_EXT = /\.[a-z0-9]{2,5}$/i;

class DriveError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// Accepts any kind of folder link, or the bare folder id.
function parseFolderLink(raw) {
  const v = String(raw || '').trim();
  if (!v) throw new DriveError('Paste the link to your Google Drive folder first.');
  let id = '';
  let resourceKey = '';
  if (/^[A-Za-z0-9_-]{15,}$/.test(v)) id = v;
  else {
    let u;
    try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { throw new DriveError("That doesn't look like a Google Drive link."); }
    if (!/(^|\.)drive\.google\.com$/i.test(u.hostname) && !process.env.DRIVE_WEB_BASE) {
      throw new DriveError('Use a link that starts with drive.google.com.');
    }
    const m = u.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
    id = m ? m[1] : (u.searchParams.get('id') || '');
    resourceKey = u.searchParams.get('resourcekey') || '';
    if (/\/file\/d\//.test(u.pathname)) throw new DriveError("That's a link to one file. Open the folder in Google Drive and copy the folder's link instead.");
  }
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new DriveError("We couldn't find a folder in that link. In Google Drive, open the folder, tap Share, then Copy link.");
  return { id, resourceKey };
}

async function get(url, { maxBytes = 5 * 1024 * 1024, asBuffer = false, timeout = 20000 } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (!HOSTS.test(current.hostname)) throw new DriveError('Google Drive sent us somewhere unexpected.');
    const res = await fetch(current, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new DriveError('A file in the folder is too big (over 40 MB).'); }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    return { status: res.status, type: res.headers.get('content-type') || '', body: asBuffer ? buf : buf.toString('utf8') };
  }
  throw new DriveError('Google Drive redirected too many times.');
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function kindOf(name, mime) {
  if (mime) {
    if (mime === 'application/vnd.google-apps.folder') return 'folder';
    if (mime.startsWith('image/')) return 'image';
    return 'other';
  }
  if (IMAGE_EXT.test(name)) return 'image';
  if (OTHER_EXT.test(name)) return 'other';
  return 'image'; // no extension: try it, and skip it if it isn't a picture
}

// The public embed page lists each item as a "flip-entry" with a link and a title.
function parseEmbedPage(html) {
  const title = decode((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s*[-–]\s*Google Drive\s*$/i, '');
  const items = [];
  const seen = new Set();
  const chunks = html.split(/<div[^>]+class="flip-entry"/i).slice(1);
  for (const c of chunks) {
    const folder = c.match(/\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/);
    const file = c.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/) || c.match(/id="entry-([A-Za-z0-9_-]{10,})"/) || c.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    const id = folder ? folder[1] : (file && file[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = decode((c.match(/class="flip-entry-title"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
    items.push({ id, name, kind: folder ? 'folder' : kindOf(name) });
  }
  if (!chunks.length) {
    // Layout changed: fall back to any file/folder links on the page.
    for (const m of html.matchAll(/\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})|\/file\/d\/([A-Za-z0-9_-]{10,})/g)) {
      const id = m[1] || m[2];
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, name: '', kind: m[1] ? 'folder' : 'image' });
    }
  }
  return { title, items };
}

async function listViaEmbed(id, resourceKey) {
  const url = `${WEB}/embeddedfolderview?id=${encodeURIComponent(id)}${resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : ''}`;
  const r = await get(url);
  if (r.status === 404 || r.status === 403 || /ServiceLogin|accounts\.google\.com/.test(r.body)) {
    throw new DriveError('We can\'t open that folder. In Google Drive, set it to "Anyone with the link" (Share → General access), then try again.');
  }
  if (r.status !== 200) throw new DriveError('Google Drive is not answering right now. Please try again in a minute.');
  const { title, items } = parseEmbedPage(r.body);
  return { id, resourceKey, name: title || 'Google Drive folder', items };
}

async function listViaApi(id, resourceKey) {
  const head = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : {};
  const call = async (url) => {
    const res = await fetch(url, { headers: head, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 || res.status === 403) {
      throw new DriveError('We can\'t open that folder. In Google Drive, set it to "Anyone with the link" (Share → General access), then try again.');
    }
    if (!res.ok) throw new DriveError('Google Drive is not answering right now. Please try again in a minute.');
    return data;
  };
  const meta = await call(`${API}/files/${encodeURIComponent(id)}?fields=name,mimeType&supportsAllDrives=true&key=${API_KEY}`);
  if (meta.mimeType !== 'application/vnd.google-apps.folder') throw new DriveError("That link isn't a folder.");
  const items = [];
  let token = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
    const data = await call(`${API}/files?q=${q}&pageSize=1000&orderBy=createdTime&fields=nextPageToken,files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${API_KEY}${token ? `&pageToken=${token}` : ''}`);
    for (const f of data.files || []) items.push({ id: f.id, name: f.name, kind: kindOf(f.name, f.mimeType) });
    token = data.nextPageToken || '';
  } while (token && items.length < 20000);
  return { id, resourceKey, name: meta.name, items };
}

// { id, resourceKey, name, images: [{id, name}], folders: [{id, name}] }
async function listFolder(id, resourceKey = '') {
  const f = API_KEY ? await listViaApi(id, resourceKey) : await listViaEmbed(id, resourceKey);
  return {
    id: f.id, resourceKey: f.resourceKey, name: f.name,
    images: f.items.filter((i) => i.kind === 'image').map(({ id: fid, name }) => ({ id: fid, name })),
    folders: f.items.filter((i) => i.kind === 'folder').map(({ id: fid, name }) => ({ id: fid, name })),
  };
}

// Downloads one photo. Drive's own resized copy (up to 2000 px, which is
// more than the website keeps) is tried first: it's fast and small. If
// that fails, the original file is downloaded.
async function downloadImage(fileId) {
  const tries = [
    `${WEB}/thumbnail?id=${encodeURIComponent(fileId)}&sz=s2000`,
    process.env.DRIVE_WEB_BASE
      ? `${WEB}/download?id=${encodeURIComponent(fileId)}`
      : `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
  ];
  let last = 'not an image';
  for (const url of tries) {
    try {
      const r = await get(url, { asBuffer: true, maxBytes: 40 * 1024 * 1024, timeout: 60000 });
      if (r.status === 200 && /^image\//i.test(r.type) && r.body.length > 100) return r.body;
      if (r.status === 200 && /octet-stream/i.test(r.type) && r.body.length > 100) return r.body; // original file
      last = `HTTP ${r.status} ${r.type}`;
    } catch (err) {
      last = err.message;
    }
  }
  throw new DriveError(`could not download (${last})`);
}

// Reads a date from a folder name such as "12 Dec 2026", "2026-12-12",
// "12.12.2026" or "Dec 12 2026". Returns YYYY-MM-DD or ''.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function dateFromName(name) {
  const s = String(name || '').toLowerCase();
  const pad = (n) => String(n).padStart(2, '0');
  const ok = (y, m, d) => (y >= 2015 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : '');
  let m = s.match(/\b(20\d\d)[-./](\d{1,2})[-./](\d{1,2})\b/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[-./](\d{1,2})[-./](20\d\d)\b/);
  if (m) return ok(+m[3], +m[2], +m[1]); // day first, as in Zimbabwe
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(20\d\d)\b/);
  if (m && MONTHS[m[2].slice(0, m[2] === 'sept' ? 4 : 3)]) return ok(+m[3], MONTHS[m[2].slice(0, 3)], +m[1]);
  m = s.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/);
  if (m && MONTHS[m[1].slice(0, 3)]) return ok(+m[3], MONTHS[m[1].slice(0, 3)], +m[2]);
  return '';
}

module.exports = { parseFolderLink, listFolder, downloadImage, dateFromName, parseEmbedPage, DriveError };

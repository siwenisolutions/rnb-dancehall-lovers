'use strict';
// Finds RnB Dancehall Lovers events on Megaticket and adds the new ones to
// the website, so nobody has to type them in. Megaticket has no organiser
// page or API, so this reads its public events list and each event's page
// (name, date, start time, venue, flyer, ticket link).
//
// Runs twice a day, at 12:00 and 21:00 Harare time (or as soon as the server
// wakes up after a missed check), and from the admin panel's "Check now".
// A Megaticket event is only ever added once: deleting it on the website
// keeps it deleted.

const { pool, insertMedia } = require('./db');
const { processImage } = require('./images');

const BASE = (process.env.MEGATICKET_BASE || 'https://www.megaticket.africa').replace(/\/+$/, '');
const LIST_PAGES = ['/events', '/events?category=music'];
// The event's name must say "Dancehall Lovers" (any spacing or case).
const MATCH = /dance\s*hall\s*lovers/i;
const CHECK_HOURS = [12, 21]; // Harare time (UTC+2, no daylight saving)
const HARARE_MS = 2 * 3600 * 1000;
// Megaticket shows start times in UTC: its "11:00" is the flyer's 1 PM.
const SITE_OFFSET = process.env.MEGATICKET_TIME_OFFSET || '+00:00';
const MAX_NEW_PER_RUN = 10;

let hooks = { assertRoom: async () => {}, changed: () => {} };
function configure(h) { hooks = { ...hooks, ...h }; }

async function get(url, binary = false) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RnBDancehallLoversWebsite/1.0)', Accept: binary ? 'image/*' : 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Megaticket answered ${res.status} for ${url}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (/^#/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });
}
function textLines(html) {
  return decode(String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<[^>]+>/g, '\n'))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function meta(html, name) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html);
  const b = a || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html);
  return b ? decode(b[1]).trim() : '';
}

// Event links on a list page whose address or card mentions Dancehall Lovers.
function findSlugs(html) {
  const out = new Set();
  const re = /href=["'](?:https?:\/\/(?:www\.)?megaticket\.africa)?\/events\/([a-z0-9][a-z0-9-]{1,120})(?:[?#][^"']*)?["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1].toLowerCase();
    // The card's own words: up to the link's end (cards are one link each).
    const chunk = html.slice(m.index, m.index + 3000);
    const end = chunk.search(/<\/a>/i);
    const near = textLines(end > 0 ? chunk.slice(0, end) : chunk.slice(0, 600)).slice(0, 8).join(' ');
    if (/dancehall-lovers|dance-hall-lovers/.test(slug) || MATCH.test(near)) out.add(slug);
  }
  return [...out];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Reads one event page. Returns null when it isn't a Dancehall Lovers event,
// and startsAt: null when its date can't be read.
function parseEvent(html, slug) {
  const title = (meta(html, 'og:title') || (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '')
    .replace(/\s*[—|-]\s*MegaTicket\s*$/i, '').trim();
  if (!title || !MATCH.test(title)) return null;
  const lines = textLines(html);
  const all = lines.join('\n');
  const d = /(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(all);
  // Ours, but the date couldn't be read: try again at the next check.
  if (!d || MONTHS.indexOf(d[2].toLowerCase()) < 0) return { slug, title, startsAt: null };
  const month = String(MONTHS.indexOf(d[2].toLowerCase()) + 1).padStart(2, '0');
  const date = `${d[3]}-${month}-${d[1].padStart(2, '0')}`;
  const t = /Doors\s*\/?\s*start[^0-9]{0,10}(\d{1,2})[:h.](\d{2})/i.exec(all);
  const startsAt = t
    ? new Date(`${date}T${t[1].padStart(2, '0')}:${t[2]}:00${SITE_OFFSET}`)
    : new Date(`${date}T18:00:00+02:00`);
  // Venue: the lines right after the start time ("TBA" until it's announced).
  let venue = '';
  const at = lines.findIndex((l) => /Doors\s*\/?\s*start/i.test(l));
  if (at >= 0) {
    for (const l of lines.slice(at + 1, at + 4)) {
      if (/^\d{1,2}[:h.]\d{2}$/.test(l)) continue;
      if (/^TBA$/i.test(l)) { venue = venue || 'TBA'; continue; }
      if (l.length > 120 || /\$|ticket|select|price|buy|sold|left/i.test(l)) break;
      venue = l;
      break;
    }
  }
  return {
    slug,
    title: title.slice(0, 200),
    startsAt,
    venue: venue === 'TBA' ? '' : venue.slice(0, 200),
    description: (meta(html, 'og:description') || '').slice(0, 5000),
    image: meta(html, 'og:image') || meta(html, 'twitter:image'),
    url: `${BASE}/events/${slug}`,
  };
}

function slugOf(url) {
  const m = /megaticket\.africa\/events\/([a-z0-9][a-z0-9-]*)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

let running = null;
async function check(reason = 'schedule') {
  if (running) return running;
  running = run(reason).finally(() => { running = null; });
  return running;
}

async function run(reason) {
  const result = { at: new Date().toISOString(), reason, found: 0, added: [], updated: [], error: null };
  try {
    // 1. Which Dancehall Lovers events does Megaticket list?
    const slugs = new Set();
    let pagesRead = 0;
    for (const p of LIST_PAGES) {
      try {
        findSlugs(await get(BASE + p)).forEach((s) => slugs.add(s));
        pagesRead += 1;
      } catch (err) {
        console.warn(`[megaticket] ${p}: ${err.message}`);
      }
    }
    if (!pagesRead) throw new Error('Could not open Megaticket. It will try again at the next check.');
    result.found = slugs.size;

    // 2. Events already on the website (typed in by hand or added before).
    const evs = await pool.query("SELECT id, ticket_url, megaticket_slug, venue, starts_at FROM events WHERE ticket_url ILIKE '%megaticket.africa/events/%' OR megaticket_slug IS NOT NULL");
    const onSite = new Map();
    for (const e of evs.rows) {
      const s = e.megaticket_slug || slugOf(e.ticket_url);
      if (s) onSite.set(s, e);
    }
    const seen = new Set((await pool.query('SELECT slug FROM megaticket_seen')).rows.map((r) => r.slug));
    for (const [s, e] of onSite) {
      if (!seen.has(s)) {
        await pool.query('INSERT INTO megaticket_seen (slug, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [s, e.id]);
        seen.add(s);
      }
    }

    // 3. Add the new ones; fill in venues that were "TBA" before.
    let added = 0;
    for (const slug of slugs) {
      const mine = onSite.get(slug);
      const needsVenue = mine && !mine.venue && new Date(mine.starts_at) > new Date();
      if (seen.has(slug) && !needsVenue) continue;
      if (!mine && added >= MAX_NEW_PER_RUN) break;
      let ev;
      try {
        ev = parseEvent(await get(`${BASE}/events/${slug}`), slug);
      } catch (err) {
        console.warn(`[megaticket] ${slug}: ${err.message}`);
        continue;
      }
      if (ev && !ev.startsAt) {
        console.warn(`[megaticket] ${slug}: could not read the date; will try again`);
        continue;
      }
      if (needsVenue) {
        if (ev && ev.venue) {
          await pool.query("UPDATE events SET venue = $1 WHERE id = $2 AND venue = ''", [ev.venue, mine.id]);
          result.updated.push(ev.title);
        }
        continue;
      }
      // Not a Dancehall Lovers event, or already over: remember and skip.
      if (!ev || ev.startsAt < new Date(Date.now() - 12 * 3600 * 1000)) {
        await pool.query('INSERT INTO megaticket_seen (slug) VALUES ($1) ON CONFLICT DO NOTHING', [slug]);
        continue;
      }
      const { rows } = await pool.query(
        `INSERT INTO events (title, venue, starts_at, description, ticket_url, megaticket_slug)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ev.title, ev.venue, ev.startsAt, ev.description, ev.url, slug]);
      const eventId = rows[0].id;
      await pool.query('INSERT INTO megaticket_seen (slug, event_id) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET event_id = EXCLUDED.event_id', [slug, eventId]);
      added += 1;
      result.added.push({ id: eventId, title: ev.title, starts_at: ev.startsAt });
      // The event's flyer becomes its poster.
      if (ev.image) {
        try {
          const buf = await get(new URL(ev.image, BASE).toString(), true);
          await hooks.assertRoom(buf.length);
          const img = await processImage(buf);
          const mediaId = await insertMedia({ category: 'event', caption: '', eventId, img, source: `megaticket:${slug}` });
          await pool.query('UPDATE events SET cover_media_id = $1 WHERE id = $2', [mediaId, eventId]);
        } catch (err) {
          console.warn(`[megaticket] flyer for ${slug}: ${err.message}`);
        }
      }
      console.log(`[megaticket] added "${ev.title}" (${ev.startsAt.toISOString()})`);
    }
    if (result.added.length || result.updated.length) hooks.changed();
  } catch (err) {
    result.error = err.message;
    console.warn(`[megaticket] check failed: ${err.message}`);
  }
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('_megaticket_last', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(result)]);
  return result;
}

async function lastResult() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = '_megaticket_last'");
  try { return rows.length ? JSON.parse(rows[0].value) : null; } catch { return null; }
}

// The most recent 12:00 or 21:00 (Harare) at or before `now`, and the next one.
function slots(now = new Date()) {
  const local = new Date(now.getTime() + HARARE_MS);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const times = [];
  for (const d of [-1, 0, 1]) for (const h of CHECK_HOURS) times.push(day + d * 86400000 + h * 3600000 - HARARE_MS);
  const t = now.getTime();
  return {
    last: new Date(Math.max(...times.filter((x) => x <= t))),
    next: new Date(Math.min(...times.filter((x) => x > t))),
  };
}

// Every 10 minutes: run if a check time has passed since the last check.
// A server that was asleep at 12:00 checks as soon as it wakes up.
function start() {
  if (process.env.MEGATICKET_CHECK === 'off') return;
  const tick = async () => {
    try {
      const last = await lastResult();
      if (!last || new Date(last.at) < slots().last) await check('schedule');
    } catch (err) {
      console.warn(`[megaticket] ${err.message}`);
    }
  };
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

module.exports = { check, lastResult, slots, start, configure, parseEvent, findSlugs };

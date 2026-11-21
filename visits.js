'use strict';
// Counts website visitors without cookies and without keeping anything
// personal. Each page sends a tiny "seen" message; counts are kept in memory
// and written to the database every 2 minutes in one go, so a crowd doesn't
// wake the database for every visitor.
const crypto = require('crypto');
const { pool } = require('./db');

const TZ = 'Africa/Harare';
const FLUSH_MS = 2 * 60 * 1000;
const LIVE_MS = 5 * 60 * 1000;
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|headless|lighthouse|pingdom|uptime|curl|wget|python|axios|node-fetch|go-http/i;
const SECRET = process.env.SESSION_SECRET || 'rnb';

const views = new Map();    // "day|path" -> count
const visitors = new Set(); // "day|code"
const sources = new Map();  // "day|source" -> count
const live = new Map();     // code -> last seen (ms)
const seenToday = new Set(); // codes already counted for a source today
let seenDay = '';

function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }

function cleanPath(p) {
  const s = String(p || '/').split('?')[0].slice(0, 120);
  if (/^\/events\/\d+$/.test(s)) return s;
  return ['/', '/events', '/gallery'].includes(s) ? s : (s.startsWith('/') ? 'other' : '/');
}

function sourceOf(ref, host) {
  try {
    const u = new URL(ref);
    const h = u.hostname.replace(/^www\./, '').replace(/^m\.|^l\.|^lm\./, '');
    if (!h || h === String(host || '').replace(/^www\./, '')) return '';
    if (/instagram\.com$/.test(h)) return 'Instagram';
    if (/facebook\.com$|fb\.me$/.test(h)) return 'Facebook';
    if (/whatsapp\.com$|wa\.me$/.test(h)) return 'WhatsApp';
    if (/t\.co$|twitter\.com$|x\.com$/.test(h)) return 'X (Twitter)';
    if (/tiktok\.com$/.test(h)) return 'TikTok';
    if (/google\./.test(h)) return 'Google';
    return h.slice(0, 60);
  } catch { return ''; }
}

// Called for each page view sent by a visitor's browser.
function record({ ip, ua, path, ref, host }) {
  if (!ua || BOT.test(ua)) return;
  const day = today();
  if (day !== seenDay) { seenDay = day; seenToday.clear(); }
  const code = crypto.createHmac('sha256', SECRET).update(`${day}|${ip}|${ua}`).digest('base64url').slice(0, 16);
  const p = cleanPath(path);
  views.set(`${day}|${p}`, (views.get(`${day}|${p}`) || 0) + 1);
  visitors.add(`${day}|${code}`);
  live.set(code, Date.now());
  if (!seenToday.has(code)) {
    seenToday.add(code);
    const src = sourceOf(ref, host) || 'Direct / unknown';
    sources.set(`${day}|${src}`, (sources.get(`${day}|${src}`) || 0) + 1);
  }
  if (live.size > 50000) for (const [k, t] of live) if (Date.now() - t > LIVE_MS) live.delete(k);
}

function liveNow() {
  const cut = Date.now() - LIVE_MS;
  let n = 0;
  for (const [k, t] of live) { if (t >= cut) n += 1; else live.delete(k); }
  return n;
}

let flushing = false;
async function flush() {
  if (flushing || (!views.size && !visitors.size && !sources.size)) return;
  flushing = true;
  const v = [...views]; views.clear();
  const u = [...visitors]; visitors.clear();
  const s = [...sources]; sources.clear();
  const client = await pool.connect().catch(() => null);
  if (!client) { // put them back for next time
    v.forEach(([k, n]) => views.set(k, (views.get(k) || 0) + n)); u.forEach((k) => visitors.add(k)); s.forEach(([k, n]) => sources.set(k, (sources.get(k) || 0) + n));
    flushing = false; return;
  }
  try {
    await client.query('BEGIN');
    if (v.length) {
      await client.query(
        `INSERT INTO visit_views (day, path, views)
         SELECT split_part(k, '|', 1)::date, substr(k, strpos(k, '|') + 1), n FROM unnest($1::text[], $2::int[]) AS t(k, n)
         ON CONFLICT (day, path) DO UPDATE SET views = visit_views.views + EXCLUDED.views`,
        [v.map((x) => x[0]), v.map((x) => x[1])]);
    }
    if (u.length) {
      await client.query(
        `INSERT INTO visit_visitors (day, visitor)
         SELECT split_part(k, '|', 1)::date, split_part(k, '|', 2) FROM unnest($1::text[]) AS t(k)
         ON CONFLICT DO NOTHING`, [u]);
    }
    if (s.length) {
      await client.query(
        `INSERT INTO visit_sources (day, source, visits)
         SELECT split_part(k, '|', 1)::date, substr(k, strpos(k, '|') + 1), n FROM unnest($1::text[], $2::int[]) AS t(k, n)
         ON CONFLICT (day, source) DO UPDATE SET visits = visit_sources.visits + EXCLUDED.visits`,
        [s.map((x) => x[0]), s.map((x) => x[1])]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn('[visits] not saved:', err.message);
  } finally {
    client.release();
    flushing = false;
  }
}

async function summary() {
  await flush();
  const day = today();
  const q = (sql, args) => pool.query(sql, args).then((r) => r.rows);
  const [daily, pages, srcs, totals] = await Promise.all([
    q(`SELECT d::date AS day,
              (SELECT count(*)::int FROM visit_visitors v WHERE v.day = d::date) AS visitors,
              (SELECT COALESCE(sum(views), 0)::int FROM visit_views w WHERE w.day = d::date) AS views
         FROM generate_series($1::date - 29, $1::date, interval '1 day') AS d ORDER BY d`, [day]),
    q(`SELECT path, sum(views)::int AS views FROM visit_views WHERE day > $1::date - 30 GROUP BY path ORDER BY 2 DESC LIMIT 8`, [day]),
    q(`SELECT source, sum(visits)::int AS visits FROM visit_sources WHERE day > $1::date - 30 GROUP BY source ORDER BY 2 DESC LIMIT 8`, [day]),
    q(`SELECT (SELECT count(*)::int FROM visit_visitors) AS visits, (SELECT COALESCE(sum(views), 0)::int FROM visit_views) AS views,
              (SELECT min(day) FROM visit_views) AS since`),
  ]);
  const sum = (n, key) => daily.slice(-n).reduce((a, d) => a + d[key], 0);
  return {
    now: liveNow(),
    today: { visitors: sum(1, 'visitors'), views: sum(1, 'views') },
    yesterday: { visitors: daily[daily.length - 2].visitors, views: daily[daily.length - 2].views },
    last7: { visitors: sum(7, 'visitors'), views: sum(7, 'views') },
    last30: { visitors: sum(30, 'visitors'), views: sum(30, 'views') },
    total: totals[0],
    daily, pages, sources: srcs,
  };
}

function start() {
  setInterval(() => flush().catch(() => {}), FLUSH_MS).unref();
  // Keep about 13 months of daily visitor codes.
  setInterval(() => pool.query("DELETE FROM visit_visitors WHERE day < current_date - 400").catch(() => {}), 24 * 3600 * 1000).unref();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { flush().finally(() => process.exit(0)); });
}

module.exports = { record, summary, flush, start, cleanPath, sourceOf };

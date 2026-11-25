'use strict';
// Counts website visitors without cookies and without keeping anything
// personal. Each page sends a tiny "seen" message, saved with one database
// statement (in the background, after the answer has gone out).
const crypto = require('crypto');
const { pool, later } = require('./db');

const TZ = 'Africa/Harare';
const LIVE_MINUTES = 5;
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|headless|lighthouse|pingdom|uptime|curl|wget|python|axios|node-fetch|go-http/i;
const SECRET = process.env.SESSION_SECRET || 'rnb';

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
  if (!ua || BOT.test(ua)) return null;
  const day = today();
  const code = crypto.createHmac('sha256', SECRET).update(`${day}|${ip}|${ua}`).digest('base64url').slice(0, 16);
  const src = sourceOf(ref, host) || 'Direct / unknown';
  // Page view, visitor (first visit today also counts its source).
  return later(pool.query(
    `WITH v AS (
       INSERT INTO visit_views (day, path, views) VALUES ($1::date, $2, 1)
       ON CONFLICT (day, path) DO UPDATE SET views = visit_views.views + 1
     ), u AS (
       INSERT INTO visit_visitors (day, visitor, last_seen) VALUES ($1::date, $3, now())
       ON CONFLICT (day, visitor) DO UPDATE SET last_seen = now()
       RETURNING (xmax = 0) AS first
     )
     INSERT INTO visit_sources (day, source, visits)
     SELECT $1::date, $4, 1 FROM u WHERE u.first
     ON CONFLICT (day, source) DO UPDATE SET visits = visit_sources.visits + 1`,
    [day, cleanPath(path), code, src]).catch((err) => console.warn('[visits] not saved:', err.message)));
}

async function summary() {
  const day = today();
  const q = (sql, args) => pool.query(sql, args).then((r) => r.rows);
  const [daily, pages, srcs, totals, live] = await Promise.all([
    q(`SELECT d::date AS day,
              (SELECT count(*)::int FROM visit_visitors v WHERE v.day = d::date) AS visitors,
              (SELECT COALESCE(sum(views), 0)::int FROM visit_views w WHERE w.day = d::date) AS views
         FROM generate_series($1::date - 29, $1::date, interval '1 day') AS d ORDER BY d`, [day]),
    q(`SELECT path, sum(views)::int AS views FROM visit_views WHERE day > $1::date - 30 GROUP BY path ORDER BY 2 DESC LIMIT 8`, [day]),
    q(`SELECT source, sum(visits)::int AS visits FROM visit_sources WHERE day > $1::date - 30 GROUP BY source ORDER BY 2 DESC LIMIT 8`, [day]),
    q(`SELECT (SELECT count(*)::int FROM visit_visitors) AS visits, (SELECT COALESCE(sum(views), 0)::int FROM visit_views) AS views,
              (SELECT min(day) FROM visit_views) AS since`),
    q(`SELECT count(*)::int AS n FROM visit_visitors WHERE last_seen > now() - make_interval(mins => $1)`, [LIVE_MINUTES]),
  ]);
  const sum = (n, key) => daily.slice(-n).reduce((a, d) => a + d[key], 0);
  return {
    now: live[0].n,
    today: { visitors: sum(1, 'visitors'), views: sum(1, 'views') },
    yesterday: { visitors: daily[daily.length - 2].visitors, views: daily[daily.length - 2].views },
    last7: { visitors: sum(7, 'visitors'), views: sum(7, 'views') },
    last30: { visitors: sum(30, 'visitors'), views: sum(30, 'views') },
    total: totals[0],
    daily, pages, sources: srcs,
  };
}

// Keep about 13 months of daily visitor codes (run by the scheduled job).
async function tidy() {
  await pool.query('DELETE FROM visit_visitors WHERE day < current_date - 400');
}

module.exports = { record, summary, tidy, cleanPath, sourceOf };

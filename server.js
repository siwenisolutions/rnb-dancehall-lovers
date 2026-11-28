'use strict';
// The website and admin panel as an Express app, run on Cloudflare Workers
// (worker.js hands requests to it; photos and videos at /media/ and the
// scheduled jobs are handled in worker.js itself).
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { findDuplicateEvent } = require('./duplicates');
const { pool, insertMedia, forgetMediaFiles, SETTING_DEFAULTS, SLOTS, SLOT_MAX } = require('./db');
const storage = require('./storage');
const jobs = require('./jobs');
const pages = require('./generated/pages');
const drive = require('./drive');
const visits = require('./visits');
const { processImage, detectVideo } = require('./images');
const { importPost } = require('./social');
const megaticket = require('./megaticket');
const auth = require('./auth');
const content = require('./content');

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_HOURS = 12;
const COOKIE = 'rnb_admin';
// *_image settings are media ids, changed only through the thumbnail upload endpoint.
const EDITABLE_SETTINGS = Object.keys(SETTING_DEFAULTS).filter((k) => !k.endsWith('_image'));
// Uploads through /photos are event photos; website sections use /slots.
const CATEGORIES = ['event'];
// Event times are entered and shown in Zimbabwe time (CAT, UTC+2, no DST).
const ZW_OFFSET = '+02:00';
// Storage cap shown to the client. With Neon Object Storage, photos and videos
// have 5 GB (free plan) and the gauge counts their real file sizes. Without it,
// files sit in the database, whose limit is 1 GiB, and the gauge measures that.
const STORAGE_LIMIT_BYTES = storage.enabled
  ? Number(process.env.MEDIA_LIMIT_MB || 5120) * 1024 * 1024
  : Number(process.env.STORAGE_LIMIT_MB || 1024) * 1024 * 1024;
const STORAGE_USED_SQL = storage.enabled
  ? '(SELECT COALESCE(sum(COALESCE(bytes, 0) + COALESCE(thumb_bytes, 0)), 0) FROM media)'
  : '(SELECT sum(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate)';

if (SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET (32+ chars) must be set: admin logins are refused until it is.');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

// Visitors' real addresses come from Cloudflare's CF-Connecting-IP header.
const VIDEO_BASE = '';
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip;
}

// The workers.dev address and www. both forward to the main domain once it is set.
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
// The site's public address, for links Google and Paynow use.
const SITE_URL = (process.env.SITE_URL || `https://${CANONICAL_HOST || 'rnbdancehalllovers.co.zw'}`).replace(/\/+$/, '');
app.use((req, res, next) => {
  if (CANONICAL_HOST && req.hostname !== CANONICAL_HOST && req.path !== '/healthz' && req.path !== '/ping') {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// Answers without touching the database (for uptime checks).
app.get('/ping', (req, res) => res.type('text').send('ok'));

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ---------- helpers ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanText(value, max, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw httpError(400, `${field} must be text.`);
  const v = value.trim();
  if (v.length > max) throw httpError(400, `${field} is too long. Please shorten it to ${max} letters or fewer.`);
  return v;
}

// Accepts links however people paste them ("megaticket.africa/...",
// "www.instagram.com/...", or a full address) and stores a full web address.
function cleanUrl(value, field) {
  let v = cleanText(value, 1000, field);
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v.replace(/^\/+/, '')}`;
  const bad = httpError(400, `${field}: that doesn't look like a website address. Open the page in your browser, copy the address from the top bar and paste it here.`);
  let u;
  try {
    u = new URL(v);
  } catch {
    throw bad;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) throw bad;
  return u.toString();
}

function cleanEmail(value) {
  const v = cleanText(value, 200, 'Email');
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw httpError(400, 'Email address looks wrong.');
  return v;
}

function parseEventTime(value) {
  const v = cleanText(value, 40, 'Date and time');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw httpError(400, 'Pick a date and time.');
  const d = new Date(`${v}:00${ZW_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw httpError(400, 'Pick a valid date and time.');
  return d.toISOString();
}

function parseId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(404, 'Not found.');
  return n;
}

// ---------- admin sessions ----------
// The cookie holds the admin's id, their session version and an expiry,
// signed with SESSION_SECRET. Changing the password (or "sign out
// everywhere") raises the version in the database, which ends older sessions.
const REMEMBER_DAYS = 30;

function sign(payload) {
  if (SESSION_SECRET.length < 32) throw httpError(503, 'The admin panel is not set up yet (SESSION_SECRET).');
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function makeSession(admin, remember) {
  const ms = remember ? REMEMBER_DAYS * 86400 * 1000 : SESSION_HOURS * 3600 * 1000;
  const payload = `v2.${admin.id}.${admin.session_version}.${Date.now() + ms}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: Math.floor(ms / 1000) };
}

// Returns { id, version } for a well-formed, unexpired, correctly signed cookie.
function readSession(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(token.slice(i + 1));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const [v, id, version, exp] = payload.split('.');
  if (v !== 'v2' || !(Number(exp) > Date.now())) return null;
  return { id: Number(id), version: Number(version) };
}

async function currentAdmin(req) {
  const sess = readSession(readCookie(req, COOKIE));
  if (!sess) return null;
  const { rows } = await pool.query(
    'SELECT id, email, name, must_change, session_version, password_changed_at, last_login_at, expires_at FROM admins WHERE id = $1', [sess.id]);
  const a = rows[0];
  if (a && a.expires_at && new Date(a.expires_at) < new Date()) return null;
  return a && a.session_version === sess.version ? a : null;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function setSessionCookie(res, value, maxAgeSeconds) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (IS_PROD) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

// Brute-force guards: 10 failed logins per IP per 15 minutes, and an account
// locks for 15 minutes after 5 wrong passwords in a row.
const failedLogins = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = failedLogins.get(ip);
  if (!entry || entry.reset < now) return false;
  return entry.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const entry = failedLogins.get(ip);
  if (!entry || entry.reset < now) failedLogins.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
  else entry.count += 1;
}
const ACCOUNT_MAX_FAILS = 5;
const LOCK_MINUTES = 15;

// Paths an admin may use before choosing their own password.
const BEFORE_PASSWORD_CHANGE = new Set(['/account', '/account/password']);

function requireAdmin(req, res, next) {
  // Writes must come from our own admin page (custom header can't be sent cross-site
  // without a CORS preflight, which we never allow). SameSite=Strict covers the rest.
  if (req.method !== 'GET' && req.get('X-RNB-Admin') !== '1') {
    return next(httpError(403, 'Request blocked.'));
  }
  currentAdmin(req).then((a) => {
    if (!a) return next(httpError(401, 'Please log in again.'));
    req.admin = a;
    if (req.method !== 'GET') res.on('finish', clearPublicCache);
    if (a.must_change && !BEFORE_PASSWORD_CHANGE.has(req.path)) {
      return next(Object.assign(httpError(403, 'Please choose your own password first.'), { code: 'must_change' }));
    }
    next();
  }, next);
}

// ---------- public API ----------

// photo_ids: up to 5 of the event's photos (cover first) for its slideshow card.
// Flyers (category 'flyer', slot 'tickets' or 'tables') belong to an event
// but are not among its photos.
const eventColumns = `e.id, e.title, e.venue, e.starts_at, e.description, e.ticket_url, e.tables_url, e.cover_media_id,
  e.megaticket_slug,
  (SELECT m.id FROM media m WHERE m.event_id = e.id AND m.category = 'flyer' AND m.slot = 'tickets' ORDER BY m.id DESC LIMIT 1) AS tickets_flyer_id,
  (SELECT m.id FROM media m WHERE m.event_id = e.id AND m.category = 'flyer' AND m.slot = 'tables' ORDER BY m.id DESC LIMIT 1) AS tables_flyer_id,
  (SELECT count(*)::int FROM media m WHERE m.event_id = e.id AND m.category <> 'flyer') AS photo_count,
  ARRAY(SELECT m.id FROM media m WHERE m.event_id = e.id AND m.category <> 'flyer'
        ORDER BY (m.id = e.cover_media_id) DESC, m.created_at, m.id LIMIT ${SLOT_MAX}) AS photo_ids`;
// An event counts as "upcoming" until 12 hours after it starts.
const UPCOMING = "e.starts_at >= now() - interval '12 hours'";
// How long a past event stays in the home page's Recent events.
const RECENT_DAYS = 30;

async function getSettings() {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%'");
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  return out;
}

// Google finding the site: robots.txt, sitemap.xml and page tags (seo.js).
const seo = require('./seo')({ pool, siteUrl: () => SITE_URL, getSettings, eventColumns, UPCOMING });
const seoCache = new Map();
app.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.robots()));
app.get('/sitemap.xml', wrap(async (req, res) => {
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(await seo.sitemap());
}));
// The workers.dev address shows the same pages: keep it out of Google.
app.use((req, res, next) => {
  if (/\.workers\.dev$/i.test(req.hostname)) res.set('X-Robots-Tag', 'noindex');
  next();
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// "Tickets on sale": every upcoming event with a ticket link (from the Events
// page), plus the two ticket cards from Website details while their event
// date hasn't passed. Soonest first; at most 4. Past tickets never show.
const TICKETS_MAX = 4;

// Where a ticket is for, worked out from the event's words, so the footer can
// say "Zimbabwe" or "South Africa" next to each ticket button.
const PLACES = [
  ['Zimbabwe', 'ZW', ['Harare', 'Bulawayo', 'Gweru', 'Mutare', 'Masvingo', 'Victoria Falls', 'Kwekwe', 'Kadoma', 'Chitungwiza', 'Marondera', 'Chinhoyi']],
  ['South Africa', 'ZA', ['Johannesburg', 'Joburg', 'Jozi', 'JHB', 'Sandton', 'Pretoria', 'Cape Town', 'Durban', 'Soweto', 'Midrand', 'Centurion', 'Randburg', 'Rosebank', 'Gauteng', 'Polokwane']],
  ['Botswana', 'BW', ['Gaborone', 'Francistown']],
  ['Zambia', 'ZM', ['Lusaka', 'Livingstone']],
  ['Mozambique', 'MZ', ['Maputo']],
  ['United Kingdom', 'GB', ['London', 'Manchester', 'Birmingham', 'Leeds']],
];
const CITY_NAMES = { JHB: 'Johannesburg', Joburg: 'Johannesburg', Jozi: 'Johannesburg' };
function placeOf(...texts) {
  const words = texts.filter(Boolean).join(' \n ');
  let best = null;
  for (const [country, flag, cities] of PLACES) {
    for (const name of [...cities, country]) {
      const m = new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').exec(words);
      if (m && (!best || m.index < best.index)) best = { index: m.index, country, flag, city: cities.includes(name) ? (CITY_NAMES[name] || name) : '' };
    }
  }
  if (!best) return {};
  return { country: best.country, flag: best.flag, place: best.city ? `${best.city}, ${best.country}` : best.country };
}
async function ticketsOnSale(settings) {
  const { rows } = await pool.query(
    `SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} AND e.ticket_url <> '' ORDER BY e.starts_at ASC LIMIT ${TICKETS_MAX}`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Harare' }).format(new Date()); // YYYY-MM-DD
  const out = rows.map((e) => ({
    kind: 'event', event_id: e.id, title: e.title, venue: e.venue, starts_at: e.starts_at, url: e.ticket_url, tables_url: e.tables_url,
    photo_ids: e.photo_ids, sort: new Date(e.starts_at).getTime(), ...placeOf(e.venue, e.title, e.description),
  }));
  // The same ticket page added twice (by hand and from Megaticket) shows once: the copy with photos.
  for (let i = out.length - 1; i >= 0; i--) {
    const j = out.findIndex((t) => t.url === out[i].url);
    if (j === i) continue;
    if ((out[i].photo_ids || []).length > (out[j].photo_ids || []).length) out[j] = out[i];
    out.splice(i, 1);
  }
  const eventUrls = new Set(out.map((t) => t.url));
  for (const n of [1, 2]) {
    const url = settings[`ticket${n}_url`];
    const date = settings[`ticket${n}_date`];
    if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || eventUrls.has(url)) continue;
    out.push({
      kind: 'card', card: n, title: settings[`ticket${n}_title`], subtitle: settings[`ticket${n}_subtitle`],
      label: settings[`ticket${n}_label`], date, url, sort: new Date(`${date}T23:59:00+02:00`).getTime(),
      ...placeOf(settings[`ticket${n}_subtitle`], settings[`ticket${n}_title`]),
    });
  }
  return out.sort((a, b) => a.sort - b.sort).slice(0, TICKETS_MAX).map(({ sort, ...t }) => t);
}

// ---------- caching for busy times ----------
// Public answers are kept in memory for 2 minutes (in each Worker instance),
// so a crowd of visitors costs a handful of database queries instead of one
// per visitor, which keeps the free database (100 compute hours a month)
// alive. Photos and videos are cached by Cloudflare (worker.js). Anything the
// admin changes clears this instance's memory straight away; other instances
// catch up within 2 minutes.
const API_TTL = 2 * 60 * 1000;
const apiCache = new Map();
let heroCache = null;
function clearPublicCache() {
  apiCache.clear();
  if (typeof seoCache !== 'undefined') seoCache.clear();
  heroCache = null;
  contentCache = null;
}
function cachedApi(req, res, next) {
  if (req.method !== 'GET') return next();
  const key = req.originalUrl;
  const hit = apiCache.get(key);
  if (hit && hit.exp > Date.now()) return res.json(hit.body);
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      apiCache.set(key, { body, exp: Date.now() + API_TTL });
      if (apiCache.size > 500) apiCache.delete(apiCache.keys().next().value);
    }
    return send(body);
  };
  next();
}
app.use(['/api/home', '/api/settings', '/api/events', '/api/photos', '/api/shop'], cachedApi);

// A page view, sent by the visitor's browser (see common.js). Admins are not counted.
app.post('/api/hit', express.text({ type: '*/*', limit: '2kb' }), (req, res) => {
  res.status(204).end();
  if (readCookie(req, COOKIE)) return;
  let body = {};
  try { body = JSON.parse(req.body || '{}'); } catch { return; }
  visits.record({ ip: clientIp(req), ua: req.get('user-agent') || '', path: body.p, ref: body.r, host: req.hostname });
});

app.get('/api/home', wrap(async (req, res) => {
  const [settings, upcoming, past, slots] = await Promise.all([
    getSettings(),
    pool.query(`SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} ORDER BY e.starts_at ASC LIMIT 3`),
    // Home page "Recent events": past events from the last 30 days only. Older ones
    // stay on the Events page (event history), photos and all.
    pool.query(`SELECT ${eventColumns} FROM events e WHERE NOT (${UPCOMING}) AND e.starts_at >= now() - interval '${RECENT_DAYS} days' ORDER BY e.starts_at DESC LIMIT 8`),
    getSlots(),
  ]);
  const tickets = await ticketsOnSale(settings);
  res.json({ settings, upcoming: upcoming.rows, past: past.rows, slots, tickets, video_base: VIDEO_BASE });
}));

// Photos (or a header video) for each picture spot on the website, in slideshow order.
async function getSlots(withDetails = false) {
  const { rows } = await pool.query(
    `SELECT id, slot, mime, caption, width, height FROM media
      WHERE category = 'site' AND slot IS NOT NULL ORDER BY created_at, id`
  );
  const out = {};
  for (const key of Object.keys(SLOTS)) out[key] = [];
  for (const r of rows) {
    if (!out[r.slot]) continue;
    out[r.slot].push(withDetails ? r : { id: r.id, mime: r.mime });
  }
  if (!withDetails) await fillFromLatestEvent(out);
  return out;
}

// The picture spots on the home page follow the most recent event that has
// photos, so the site always shows the latest night without anyone swapping
// pictures by hand. The header keeps whatever was uploaded for it (the video).
// Ticket cards only borrow event photos when nobody uploaded their own.
const AUTO_SLOTS = {
  exp1: 'portrait', exp2: 'portrait', exp3: 'portrait',
  join1: 'portrait', join2: 'portrait', promo: 'landscape',
  ticket1: 'landscape', ticket2: 'landscape',
  intro1: 'landscape', intro2: 'landscape',
};
const AUTO_PER_SLOT = 3;
async function fillFromLatestEvent(out) {
  const { rows } = await pool.query(
    `SELECT m.id, m.mime, m.width, m.height FROM media m
      WHERE m.event_id = (
        SELECT e.id FROM events e
         WHERE e.starts_at <= now() AND EXISTS (SELECT 1 FROM media x WHERE x.event_id = e.id AND x.mime LIKE 'image/%' AND x.category <> 'flyer')
         ORDER BY e.starts_at DESC LIMIT 1)
        AND m.mime LIKE 'image/%' AND m.category <> 'flyer'
      ORDER BY m.id`);
  if (!rows.length) return;
  const pools = { portrait: [], landscape: [] };
  for (const r of rows) (r.height > r.width ? pools.portrait : pools.landscape).push(r);
  // Spread the picks across the whole event (not just the first photos
  // imported), and never show the same photo in two spots.
  const used = new Set();
  const spread = (list, n) => {
    const free = list.filter((r) => !used.has(r.id));
    if (!free.length) return [];
    const step = free.length / n;
    const picks = [];
    for (let i = 0; i < n && i < free.length; i += 1) picks.push(free[Math.floor(i * step + step / 2) % free.length]);
    return [...new Set(picks)];
  };
  const entries = Object.entries(AUTO_SLOTS);
  const need = { portrait: 0, landscape: 0 };
  for (const [, shape] of entries) need[shape] += AUTO_PER_SLOT;
  const chosen = {
    portrait: spread(pools.portrait.length >= AUTO_PER_SLOT ? pools.portrait : rows, need.portrait),
    landscape: spread(pools.landscape.length >= AUTO_PER_SLOT ? pools.landscape : rows, need.landscape),
  };
  const next = { portrait: 0, landscape: 0 };
  for (const [slot, shape] of entries) {
    if ((slot.startsWith('ticket') || slot.startsWith('intro')) && out[slot].length) continue;
    const list = chosen[shape];
    const picks = [];
    while (picks.length < AUTO_PER_SLOT && next[shape] < list.length) {
      const r = list[next[shape]++];
      if (used.has(r.id)) continue;
      used.add(r.id);
      picks.push({ id: r.id, mime: r.mime });
    }
    // Not enough photos of the right shape left: any unused photo will do.
    for (const r of rows) {
      if (picks.length) break;
      if (used.has(r.id)) continue;
      used.add(r.id);
      picks.push({ id: r.id, mime: r.mime });
    }
    // Few photos at the latest event: the intro cards may repeat one rather than stay empty.
    if (!picks.length && slot.startsWith('intro')) picks.push({ id: rows[slot === 'intro1' ? 0 : rows.length - 1].id, mime: 'image/webp' });
    if (picks.length) out[slot] = picks;
  }
}

app.get('/api/settings', wrap(async (req, res) => {
  res.json(await getSettings());
}));

app.get('/api/events', wrap(async (req, res) => {
  const [upcoming, past] = await Promise.all([
    pool.query(`SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} ORDER BY e.starts_at ASC`),
    pool.query(`SELECT ${eventColumns} FROM events e WHERE NOT (${UPCOMING}) ORDER BY e.starts_at DESC`),
  ]);
  res.json({ upcoming: upcoming.rows, past: past.rows });
}));

app.get('/api/events/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const ev = await pool.query(`SELECT ${eventColumns}, (${UPCOMING}) AS is_upcoming FROM events e WHERE e.id = $1`, [id]);
  if (ev.rowCount === 0) throw httpError(404, 'Event not found.');
  const photos = await pool.query(
    "SELECT id, caption, width, height FROM media WHERE event_id = $1 AND category <> 'flyer' ORDER BY created_at DESC, id DESC",
    [id]
  );
  res.json({ event: ev.rows[0], photos: photos.rows });
}));

app.get('/api/photos', wrap(async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const params = [limit + 1, offset];
  // Gallery: every photo on the site (videos are not shown in the gallery).
  const filters = {
    '': "m.mime LIKE 'image/%' AND m.category NOT IN ('flyer', 'product')",
    event: "m.category = 'event'",
    experience: "m.category = 'site' AND m.slot IN ('exp1', 'exp2', 'exp3')",
    gallery: "m.mime LIKE 'image/%' AND m.category NOT IN ('event', 'flyer', 'product') AND (m.slot IS NULL OR m.slot NOT IN ('exp1', 'exp2', 'exp3'))",
  };
  if (!(category in filters)) throw httpError(400, 'Unknown category.');
  const where = `WHERE ${filters[category]}`;
  const { rows } = await pool.query(
    // taken_at: the event's date for event photos, otherwise when it was added.
    // The gallery groups photos by that day, newest first, like a phone.
    `SELECT m.id, m.category, m.slot, m.caption, m.width, m.height, m.event_id, e.title AS event_title,
            COALESCE(e.starts_at, m.created_at) AS taken_at
       FROM media m LEFT JOIN events e ON e.id = m.event_id
       ${where}
       ORDER BY COALESCE(e.starts_at, m.created_at) DESC, m.event_id NULLS LAST, m.created_at, m.id
       LIMIT $1 OFFSET $2`,
    params
  );
  res.json({ photos: rows.slice(0, limit), more: rows.length > limit });
}));

// ---------- admin API ----------

app.post('/api/admin/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (tooManyAttempts(clientIp(req))) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const body = req.body || {};
  const email = auth.normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const { rows } = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
  const a = rows[0];
  if (a && a.locked_until && new Date(a.locked_until) > new Date()) {
    throw httpError(429, `Too many wrong passwords. This login is locked for ${Math.ceil((new Date(a.locked_until) - Date.now()) / 60000)} more minutes.`);
  }
  const ok = await auth.verifyPassword(password, a && a.password_hash);
  if (a && ok && a.expires_at && new Date(a.expires_at) < new Date()) {
    throw httpError(401, 'This temporary login has expired. Ask Siweni Innovative Solutions for a new one.');
  }
  if (!a || !ok) {
    recordFailure(clientIp(req));
    if (a) {
      await pool.query(
        `UPDATE admins SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1`, [a.id, ACCOUNT_MAX_FAILS, LOCK_MINUTES]);
    }
    throw httpError(401, 'Wrong email or password.');
  }
  failedLogins.delete(clientIp(req));
  await pool.query('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [a.id]);
  const sess = makeSession(a, body.remember === true);
  setSessionCookie(res, sess.value, sess.maxAge);
  res.json({ ok: true, mustChange: a.must_change, email: a.email, name: a.name, temporary: !!a.expires_at, expiresAt: a.expires_at });
}));

app.post('/api/admin/logout', (req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/session', wrap(async (req, res) => {
  const a = await currentAdmin(req);
  res.json(a ? { loggedIn: true, email: a.email, name: a.name, mustChange: a.must_change, temporary: !!a.expires_at, expiresAt: a.expires_at } : { loggedIn: false });
}));

const admin = express.Router();
admin.use(requireAdmin);
admin.use(express.json({ limit: '100kb' }));

// ---------- your account ----------

admin.get('/account', (req, res) => {
  const a = req.admin;
  res.json({ email: a.email, name: a.name, mustChange: a.must_change, passwordChangedAt: a.password_changed_at, lastLoginAt: a.last_login_at });
});

// Change name and/or login email. Changing the email needs the current password.
admin.put('/account', wrap(async (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name === undefined ? req.admin.name : body.name, 100, 'Your name');
  const email = body.email === undefined ? req.admin.email : auth.normaliseEmail(body.email);
  if (!auth.validEmail(email)) throw httpError(400, 'Please enter a valid email address.');
  if (email !== req.admin.email) {
    const { rows } = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.id]);
    if (!(await auth.verifyPassword(String(body.current_password || ''), rows[0].password_hash))) {
      throw httpError(400, 'Your current password is not right.');
    }
    const taken = await pool.query('SELECT 1 FROM admins WHERE email = $1 AND id <> $2', [email, req.admin.id]);
    if (taken.rowCount) throw httpError(400, 'Another login already uses that email.');
  }
  await pool.query('UPDATE admins SET name = $2, email = $3 WHERE id = $1', [req.admin.id, name, email]);
  res.json({ ok: true, email, name });
}));

// Choose a new password. Signs out every other device; this one stays signed in.
admin.post('/account/password', wrap(async (req, res) => {
  const body = req.body || {};
  const { rows } = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.id]);
  if (!(await auth.verifyPassword(String(body.current_password || ''), rows[0].password_hash))) {
    throw httpError(400, 'Your current password is not right.');
  }
  // A temporary login also gets its owner's own email (and name) here.
  let email = req.admin.email;
  let name = req.admin.name;
  if (body.email !== undefined || req.admin.expires_at) {
    email = auth.normaliseEmail(body.email);
    if (!auth.validEmail(email)) throw httpError(400, 'Please enter your own email address. You will log in with it.');
    const taken = await pool.query('SELECT 1 FROM admins WHERE email = $1 AND id <> $2', [email, req.admin.id]);
    if (taken.rowCount) throw httpError(400, 'Another login already uses that email.');
  }
  if (body.name !== undefined) name = cleanText(body.name, 100, 'Your name');
  const next = String(body.new_password || '');
  const problem = auth.passwordProblem(next, email);
  if (problem) throw httpError(400, problem);
  if (await auth.verifyPassword(next, rows[0].password_hash)) throw httpError(400, 'Choose a password different from the one you have now.');
  const u = await pool.query(
    `UPDATE admins SET password_hash = $2, must_change = false, password_changed_at = now(), expires_at = NULL,
            email = $3, name = $4, session_version = session_version + 1 WHERE id = $1 RETURNING id, session_version`,
    [req.admin.id, await auth.hashPassword(next), email, name]);
  const sess = makeSession(u.rows[0], body.remember === true);
  setSessionCookie(res, sess.value, sess.maxAge);
  res.json({ ok: true, email, name });
}));

// Sign out on every phone and computer, including this one.
admin.post('/account/sign-out-everywhere', wrap(async (req, res) => {
  await pool.query('UPDATE admins SET session_version = session_version + 1 WHERE id = $1', [req.admin.id]);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
}));

// ---------- website text ----------

var contentCache = null;
async function savedContent() {
  if (contentCache && contentCache.exp > Date.now()) return contentCache.value;
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'c:%'");
  const out = {};
  for (const r of rows) out[r.key.slice(2)] = r.value;
  contentCache = { value: out, exp: Date.now() + API_TTL };
  return out;
}

admin.get('/content', wrap(async (req, res) => {
  const saved = await savedContent();
  // "One event" previews the newest event that has photos (else any event).
  const ev = await pool.query('SELECT e.id FROM events e ORDER BY (SELECT count(*) FROM media m WHERE m.event_id = e.id) > 0 DESC, e.starts_at DESC LIMIT 1');
  const eventId = ev.rows[0] && ev.rows[0].id;
  res.json({
    sections: content.SECTIONS.map((sec) => ({
      ...sec, url: sec.url && sec.url.includes(':event') ? (eventId ? sec.url.replace(':event', eventId) : null) : sec.url,
    })),
    fields: content.FIELDS.map((f) => ({
      key: f.key, page: f.page, section: f.section, label: f.label, type: f.type, hint: f.hint || '', accent: f.accent || '', client: !!f.client,
      default: f.def, value: saved[f.key] === undefined ? '' : saved[f.key],
    })),
  });
}));

// Save some fields: { key: text }. An empty text goes back to the original words.
admin.put('/content', wrap(async (req, res) => {
  const body = req.body || {};
  const updates = [];
  for (const [key, value] of Object.entries(body)) {
    const f = content.BY_KEY.get(key);
    if (!f) throw httpError(400, 'Unknown text field.');
    updates.push([key, content.clean(f, value)]);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of updates) {
      const f = content.BY_KEY.get(key);
      if (value === '' || value === f.def) await client.query('DELETE FROM settings WHERE key = $1', [`c:${key}`]);
      else {
        await client.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [`c:${key}`, value]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    contentCache = null;
  }
  res.json({ ok: true, saved: updates.length });
}));

// Visitor numbers for the admin overview page.
admin.get('/visits', wrap(async (req, res) => {
  res.json(await visits.summary());
}));

// Numbers for the admin overview page.
admin.get('/stats', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM events e WHERE ${UPCOMING}) AS upcoming,
      (SELECT count(*)::int FROM events e WHERE NOT (${UPCOMING})) AS past,
      (SELECT count(*)::int FROM media WHERE mime LIKE 'image/%') AS photos,
      (SELECT count(*)::int FROM media WHERE mime LIKE 'video/%') AS videos,
      (SELECT count(*)::int FROM media WHERE category = 'site' AND mime LIKE 'image/%') AS site_photos,
      (SELECT count(*)::int FROM media WHERE category = 'event') AS event_photos,
      (SELECT count(*)::int FROM media WHERE mime LIKE 'image/%' AND created_at > now() - interval '30 days') AS photos_30d,
      (SELECT COALESCE(avg(COALESCE(bytes, 0) + COALESCE(thumb_bytes, 0)), 400000)::bigint FROM media WHERE mime LIKE 'image/%') AS avg_photo_bytes,
      ${STORAGE_USED_SQL}::bigint AS db_bytes,
      (SELECT count(*)::int FROM media WHERE video_state = 'pending') AS videos_compressing`);
  const s = rows[0];
  const used = Number(s.db_bytes);
  res.json({
    ...s,
    db_bytes: used,
    avg_photo_bytes: Number(s.avg_photo_bytes),
    storage_limit_bytes: STORAGE_LIMIT_BYTES,
    photos_left: Math.max(0, Math.floor((STORAGE_LIMIT_BYTES - used) / Number(s.avg_photo_bytes))),
  });
}));

// Names used in error messages, matching the labels in the admin panel.
const SETTING_LABELS = {
  hero_text: 'Home page tagline', about_text: 'About us', contact_email: 'Email', phone: 'Phone', address: 'Address',
  instagram_url: 'Instagram', facebook_url: 'Facebook', tiktok_url: 'TikTok', whatsapp_url: 'WhatsApp channel', google_verification: 'Google verification code', youtube_url: 'YouTube',
  ticket1_title: 'Ticket card 1 event name', ticket1_subtitle: 'Ticket card 1 where', ticket1_label: 'Ticket card 1 button text', ticket1_url: 'Ticket card 1 ticket website',
  exp1_label: 'Experience card 1 word', exp2_label: 'Experience card 2 word', exp3_label: 'Experience card 3 word',
  ticket1_date: 'Ticket card 1 event date', ticket2_date: 'Ticket card 2 event date',
  ticket2_title: 'Ticket card 2 event name', ticket2_subtitle: 'Ticket card 2 where', ticket2_label: 'Ticket card 2 button text', ticket2_url: 'Ticket card 2 ticket website',
};

admin.put('/settings', wrap(async (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const key of EDITABLE_SETTINGS) {
    if (!(key in body)) continue;
    const label = SETTING_LABELS[key] || key;
    if (key.endsWith('_url')) updates[key] = cleanUrl(body[key], label);
    else if (key.endsWith('_date')) {
      const v = String(body[key] || '').trim();
      if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)))) throw httpError(400, `${label}: please pick a date.`);
      updates[key] = v;
    }
    else if (key === 'google_verification') {
      // Accepts the code or the whole <meta name="google-site-verification" content="…"> tag.
      const raw = String(body[key] || '').trim();
      const v = (/content=["']([^"']+)["']/i.exec(raw) || [null, raw])[1].trim();
      if (v && !/^[A-Za-z0-9_-]{10,100}$/.test(v)) throw httpError(400, 'Google verification: paste the code (or the whole meta tag) from Google Search Console.');
      updates[key] = v;
    }
    else if (key === 'contact_email') updates[key] = cleanEmail(body[key]);
    else updates[key] = cleanText(body[key], 2000, label);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(updates)) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(await getSettings());
}));

function eventFromBody(body) {
  const title = cleanText(body.title, 200, 'Title');
  if (!title) throw httpError(400, 'Give the event a title.');
  return {
    title,
    venue: cleanText(body.venue, 200, 'Venue'),
    startsAt: parseEventTime(body.starts_at),
    description: cleanText(body.description, 5000, 'Description'),
    ticketUrl: cleanUrl(body.ticket_url, 'Where to buy tickets'),
    tablesUrl: cleanUrl(body.tables_url, 'Where to book tables'),
  };
}

admin.post('/events', wrap(async (req, res) => {
  const e = eventFromBody(req.body || {});
  // Probably the same night as an event that already exists: ask first (the admin
  // can update that event instead, or confirm with force: true).
  if (!(req.body || {}).force) {
    const dup = await findDuplicateEvent(pool, { title: e.title, venue: e.venue, startsAt: e.startsAt });
    if (dup) {
      throw Object.assign(httpError(409, `"${dup.title}" is already on the website for that day.`), {
        code: 'duplicate_event',
        duplicate: { id: dup.id, title: dup.title, venue: dup.venue, starts_at: dup.starts_at },
      });
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO events (title, venue, starts_at, description, ticket_url, tables_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [e.title, e.venue, e.startsAt, e.description, e.ticketUrl, e.tablesUrl]
  );
  res.status(201).json({ id: rows[0].id });
}));

// ---------- Google Drive ----------

// Looks inside a shared folder: its photos and the folders in it (with their
// photo counts), so the admin can choose what to bring in.
admin.post('/drive/look', wrap(async (req, res) => {
  const { id, resourceKey } = drive.parseFolderLink((req.body || {}).url);
  const top = await drive.listFolder(id, resourceKey);
  const subs = top.folders.slice(0, 30);
  const counted = [];
  for (let i = 0; i < subs.length; i += 4) {
    counted.push(...await Promise.all(subs.slice(i, i + 4).map(async (f) => {
      try {
        const l = await drive.listFolder(f.id, '');
        return { id: f.id, name: f.name || l.name, images: l.images.length, folders: l.folders.length, date: drive.dateFromName(f.name || l.name) };
      } catch {
        return { id: f.id, name: f.name, images: 0, folders: 0, date: drive.dateFromName(f.name), error: true };
      }
    })));
  }
  const linked = await pool.query('SELECT id, title FROM events WHERE drive_folder = ANY($1::text[])', [[id, ...subs.map((f) => f.id)]]);
  res.json({
    folder: { id, resourceKey, name: top.name, images: top.images.length, date: drive.dateFromName(top.name) },
    folders: counted,
    more_folders: Math.max(0, top.folders.length - subs.length),
    linked: linked.rows,
  });
}));

async function linkFolder(eventId, folderId, resourceKey, name, db = pool) {
  await db.query('UPDATE events SET drive_folder = $2, drive_resource_key = $3, drive_name = $4 WHERE id = $1',
    [eventId, folderId, resourceKey || '', String(name || '').slice(0, 200)]);
}
function cleanFolderId(v) {
  const s = String(v || '');
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(s)) throw httpError(400, 'That folder is not valid. Look at the folder again.');
  return s;
}

// Bring photos in: either into one existing event, or as new events (one per folder).
admin.post('/drive/import', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.mode === 'existing') {
    const eventId = parseId(body.event_id);
    const ev = await pool.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
    if (!ev.rowCount) throw httpError(400, 'That event no longer exists.');
    await linkFolder(eventId, cleanFolderId(body.folder_id), body.resource_key, cleanText(body.name, 200, 'Folder'));
    const jobId = await jobs.queueDriveImport(eventId);
    return res.status(201).json({ events: [eventId], jobs: [jobId] });
  }
  const list = Array.isArray(body.events) ? body.events : [];
  if (!list.length) throw httpError(400, 'Choose at least one folder.');
  if (list.length > 30) throw httpError(400, 'Bring in at most 30 folders at a time.');
  const created = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of list) {
      const date = String(item.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, `Pick a date for "${String(item.title || item.name || 'an event').slice(0, 60)}".`);
      const e = eventFromBody({ title: item.title, venue: item.venue, starts_at: `${date}T${/^\d{2}:\d{2}$/.test(item.time || '') ? item.time : '20:00'}`, description: '', ticket_url: '' });
      // An event for that night already exists: put the photos there instead of making a copy.
      const dup = await findDuplicateEvent(client, { title: e.title, venue: e.venue, startsAt: e.startsAt });
      const eventId = dup ? dup.id
        : (await client.query('INSERT INTO events (title, venue, starts_at) VALUES ($1, $2, $3) RETURNING id', [e.title, e.venue, e.startsAt])).rows[0].id;
      await linkFolder(eventId, cleanFolderId(item.folder_id), item.resource_key, cleanText(item.name, 200, 'Folder'), client);
      created.push(eventId);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const jobIds = [];
  for (const id of created) jobIds.push(await jobs.queueDriveImport(id));
  res.status(201).json({ events: created, jobs: jobIds });
}));

// Progress of recent imports, newest first.
admin.get('/drive/imports', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.event_id, e.title, d.status, d.total, d.added, d.skipped, d.failed, d.error, d.automatic, d.created_at, d.finished_at
       FROM drive_imports d JOIN events e ON e.id = d.event_id
      WHERE NOT d.automatic OR d.added > 0 OR d.status IN ('pending', 'running', 'failed')
      ORDER BY d.id DESC LIMIT 15`);
  // The panel asks every few seconds while an import runs: each ask moves it one step on.
  if (rows.some((r) => r.status === 'pending' || r.status === 'running') && await jobs.needsWork()) jobs.kick();
  res.json({ imports: rows });
}));

admin.get('/events/:id/drive', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query('SELECT drive_folder, drive_resource_key, drive_name, drive_synced_at FROM events WHERE id = $1', [id]);
  if (!rows.length) throw httpError(404, 'Event not found.');
  const r = rows[0];
  res.json(r.drive_folder ? {
    linked: true, name: r.drive_name, synced_at: r.drive_synced_at,
    url: `https://drive.google.com/drive/folders/${r.drive_folder}${r.drive_resource_key ? `?resourcekey=${r.drive_resource_key}` : ''}`,
  } : { linked: false });
}));

admin.post('/events/:id/drive/sync', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const jobId = await jobs.queueDriveImport(id);
  if (!jobId) throw httpError(400, 'This event is not linked to a Google Drive folder.');
  res.json({ job: jobId });
}));

admin.delete('/events/:id/drive', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  await pool.query("UPDATE events SET drive_folder = NULL, drive_resource_key = '', drive_name = '' WHERE id = $1", [id]);
  res.json({ ok: true });
}));

admin.put('/events/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const e = eventFromBody(req.body || {});
  const r = await pool.query(
    `UPDATE events SET title = $1, venue = $2, starts_at = $3, description = $4, ticket_url = $5, tables_url = $6
     WHERE id = $7`,
    [e.title, e.venue, e.startsAt, e.description, e.ticketUrl, e.tablesUrl, id]
  );
  if (r.rowCount === 0) throw httpError(404, 'Event not found.');
  res.json({ ok: true });
}));

// Megaticket: events found there are added by themselves (megaticket.js).
admin.get('/megaticket', wrap(async (req, res) => {
  const { next } = megaticket.slots();
  res.json({ last: await megaticket.lastResult(), next });
}));
admin.post('/megaticket/check', wrap(async (req, res) => {
  const result = await megaticket.check('admin');
  res.json({ last: result, next: megaticket.slots().next });
}));

// Quick add: read a public social media post (caption + picture) from its link.
admin.post('/import-post', wrap(async (req, res) => {
  res.json(await importPost((req.body || {}).url));
}));

admin.delete('/events/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  // Event photos are removed with the event (ON DELETE CASCADE).
  const r = await pool.query('DELETE FROM events WHERE id = $1', [id]);
  if (r.rowCount === 0) throw httpError(404, 'Event not found.');
  // Their files in object storage are cleared by the scheduled job.
  res.json({ ok: true });
}));

// Uploads. The admin panel sends each photo already shrunk, with its
// thumbnail in a second field named "<field>_thumb" (same order). These
// helpers accept both and hang each thumbnail on its photo (file.thumb).
function makeUpload(limits) {
  const m = multer({ storage: multer.memoryStorage(), limits: { ...limits, files: limits.files * 2 } });
  const pair = (req, name) => {
    const files = (req.files && req.files[name]) || [];
    const thumbs = (req.files && req.files[`${name}_thumb`]) || [];
    files.forEach((f, i) => { f.thumb = thumbs[i] || null; });
    return files;
  };
  return {
    array: (name, max) => [m.fields([{ name, maxCount: max }, { name: `${name}_thumb`, maxCount: max }]),
      (req, res, next) => { req.files = pair(req, name); next(); }],
    single: (name) => [m.fields([{ name, maxCount: 1 }, { name: `${name}_thumb`, maxCount: 1 }]),
      (req, res, next) => { req.file = pair(req, name)[0]; req.files = undefined; next(); }],
  };
}
const upload = makeUpload({ fileSize: 15 * 1024 * 1024, files: 20 });

// Merchandise shop and its payments (shop.js).
require('./shop')(app, admin, {
  pool, insertMedia, forgetMediaFiles, processImage, assertRoomFor: (n) => assertRoomFor(n), httpError, wrap, cleanText, parseId,
  upload, clientIp, clearPublicCache, siteUrl: () => SITE_URL,
});

// Visitor contacts: "Get event updates" signups and shop customers (contacts.js).
require('./contacts')(app, admin, { pool, httpError, wrap, cleanText, parseId, clientIp });

// Upload one or more photos. category=event requires event_id.
// cover=1 (event only) makes the first uploaded photo the event's poster/cover.
admin.post('/photos', upload.array('photos', 20), wrap(async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) throw httpError(400, 'Choose at least one photo.');
  const category = req.body.category;
  if (!CATEGORIES.includes(category)) throw httpError(400, 'Choose where the photos go.');
  let eventId = null;
  if (category === 'event') {
    eventId = parseId(req.body.event_id);
    const ev = await pool.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
    if (ev.rowCount === 0) throw httpError(400, 'That event no longer exists.');
  }
  const caption = cleanText(req.body.caption, 200, 'Caption');
  await assertRoomFor(files.reduce((n, f) => n + f.size, 0));
  const ids = [];
  for (const file of files) {
    const img = await processImage(file.buffer, file.thumb && file.thumb.buffer);
    ids.push(await insertMedia({ category, caption, eventId, img }));
  }
  if (eventId && req.body.cover === '1') {
    await pool.query('UPDATE events SET cover_media_id = $1 WHERE id = $2', [ids[0], eventId]);
  } else if (eventId) {
    // First photo of an event without a cover becomes its cover automatically.
    await pool.query('UPDATE events SET cover_media_id = $1 WHERE id = $2 AND cover_media_id IS NULL', [ids[0], eventId]);
  }
  res.status(201).json({ ids });
}));

// ---------- picture sections (slots) ----------

// Videos for the header can be bigger than photos. (A Worker has 128 MB of
// memory, so videos stay under 40 MB; they are kept as uploaded.)
const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB || 40);
const uploadMedia = makeUpload({ fileSize: VIDEO_MAX_MB * 1024 * 1024, files: SLOT_MAX });

async function storageUsed(db = pool) {
  const { rows } = await db.query(`SELECT ${STORAGE_USED_SQL}::bigint AS b`);
  return Number(rows[0].b);
}
// Flyers for tickets and table bookings: one of each per event. A new one
// replaces the old one.
const FLYER_KINDS = ['tickets', 'tables'];
admin.post('/events/:id/flyers/:kind', upload.single('photo'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const kind = req.params.kind;
  if (!FLYER_KINDS.includes(kind)) throw httpError(404, 'Not found.');
  if (!req.file) throw httpError(400, 'Choose a flyer.');
  const ev = await pool.query('SELECT 1 FROM events WHERE id = $1', [id]);
  if (!ev.rowCount) throw httpError(400, 'That event no longer exists.');
  await assertRoomFor(req.file.size);
  const img = await processImage(req.file.buffer, req.file.thumb && req.file.thumb.buffer);
  const newId = await insertMedia({ category: 'flyer', caption: '', eventId: id, img, slot: kind });
  const old = await pool.query("DELETE FROM media WHERE event_id = $1 AND category = 'flyer' AND slot = $2 AND id <> $3 RETURNING id", [id, kind, newId]);
  old.rows.forEach((r) => forgetMediaFiles(r.id));
  res.status(201).json({ id: newId });
}));
admin.delete('/events/:id/flyers/:kind', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!FLYER_KINDS.includes(req.params.kind)) throw httpError(404, 'Not found.');
  const old = await pool.query("DELETE FROM media WHERE event_id = $1 AND category = 'flyer' AND slot = $2 RETURNING id", [id, req.params.kind]);
  old.rows.forEach((r) => forgetMediaFiles(r.id));
  res.json({ ok: true });
}));

async function assertRoomFor(bytes, db = pool) {
  if ((await storageUsed(db)) + bytes > STORAGE_LIMIT_BYTES * 0.98) {
    throw httpError(400, 'Your storage is full. Delete some old photos or videos first, or ask Siweni to upgrade your storage.');
  }
}

// Turns an uploaded file into something we can store: a resized photo, or a
// header video exactly as uploaded.
async function prepareUpload(file, allowVideo) {
  const video = detectVideo(file.buffer);
  if (video) {
    if (!allowVideo) throw httpError(400, 'Videos can only be used for the header background. Please choose a photo here.');
    return { mime: video, width: 0, height: 0, data: file.buffer, thumb: Buffer.alloc(0), videoState: 'done' };
  }
  if (file.size > 15 * 1024 * 1024) throw httpError(400, 'Each photo must be under 15 MB.');
  return processImage(file.buffer, file.thumb && file.thumb.buffer);
}

admin.get('/slots', wrap(async (req, res) => {
  const slots = await getSlots(true);
  res.json({
    max: SLOT_MAX,
    slots: Object.entries(SLOTS).map(([key, def]) => ({
      key, label: def.label, where: def.where, video: !!def.video, items: slots[key],
    })),
  });
}));

// Add photos (or one header video) to a picture section. Max 5 per section.
admin.post('/slots/:slot', uploadMedia.array('files', SLOT_MAX), wrap(async (req, res) => {
  const slot = req.params.slot;
  const def = SLOTS[slot];
  if (!def) throw httpError(404, 'Not found.');
  const files = req.files || [];
  if (files.length === 0) throw httpError(400, 'Choose at least one photo.');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM media WHERE slot = $1', [slot]);
  const room = SLOT_MAX - rows[0].n;
  if (room <= 0) throw httpError(400, `${def.label} already has ${SLOT_MAX} photos. Replace or delete one first.`);
  if (files.length > room) throw httpError(400, `${def.label} only has room for ${room} more photo${room === 1 ? '' : 's'} (${SLOT_MAX} at most).`);
  await assertRoomFor(files.reduce((n, f) => n + f.size, 0));
  const prepared = [];
  for (const file of files) prepared.push(await prepareUpload(file, def.video));
  const ids = [];
  for (const img of prepared) ids.push(await insertMedia({ category: 'site', caption: '', eventId: null, img, slot }));
  res.status(201).json({ ids, compressing: false });
}));

// Replace a photo with a new one, keeping its place (section, event, order, cover).
admin.post('/photos/:id/replace', uploadMedia.single('file'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!req.file) throw httpError(400, 'Choose a photo.');
  const old = await pool.query('SELECT category, slot, event_id, caption, created_at FROM media WHERE id = $1', [id]);
  if (old.rowCount === 0) throw httpError(404, 'Photo not found.');
  const o = old.rows[0];
  const allowVideo = !!(o.slot && SLOTS[o.slot] && SLOTS[o.slot].video);
  await assertRoomFor(req.file.size);
  const img = await prepareUpload(req.file, allowVideo);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newId = await insertMedia({ category: o.category, caption: o.caption, eventId: o.event_id, img, slot: o.slot, createdAt: o.created_at }, client);
    await client.query('UPDATE events SET cover_media_id = $1 WHERE cover_media_id = $2', [newId, id]);
    await rememberRemoved(id, client);
    await client.query('DELETE FROM media WHERE id = $1', [id]);
    await client.query('COMMIT');
    forgetMediaFiles(id);
    res.status(201).json({ id: newId, compressing: false });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

admin.put('/photos/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const caption = cleanText((req.body || {}).caption, 200, 'Caption');
  const r = await pool.query('UPDATE media SET caption = $1 WHERE id = $2', [caption, id]);
  if (r.rowCount === 0) throw httpError(404, 'Photo not found.');
  res.json({ ok: true });
}));

admin.post('/events/:id/cover', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const mediaId = parseId((req.body || {}).media_id);
  const r = await pool.query(
    'UPDATE events SET cover_media_id = $1 WHERE id = $2 AND EXISTS (SELECT 1 FROM media WHERE id = $1 AND event_id = $2)',
    [mediaId, id]
  );
  if (r.rowCount === 0) throw httpError(400, 'That photo does not belong to this event.');
  res.json({ ok: true });
}));

// A Drive photo removed from the website is remembered, so the folder sync
// doesn't bring it back.
async function rememberRemoved(id, db = pool) {
  await db.query(
    `INSERT INTO drive_removed (event_id, source)
     SELECT event_id, source FROM media WHERE id = $1 AND source IS NOT NULL AND event_id IS NOT NULL
     ON CONFLICT DO NOTHING`, [id]);
}

admin.delete('/photos/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  await rememberRemoved(id);
  const r = await pool.query('DELETE FROM media WHERE id = $1', [id]);
  if (r.rowCount === 0) throw httpError(404, 'Photo not found.');
  forgetMediaFiles(id);
  res.json({ ok: true });
}));

app.use('/api/admin', admin);

// ---------- pages ----------
// Page files are built into generated/pages.js at deploy time (npm run build),
// with "?v=<content hash>" on their CSS/JS links, so a browser never pairs a
// new page with an old cached stylesheet or script. CSS, JS, images and the
// welcome video are served by Cloudflare straight from public/ (static assets).
function assetVersion(urlPath) {
  return pages.versions[urlPath] || '0';
}
function sendPage(res, file, status = 200) {
  const html = pages.html[file];
  if (!html) return res.status(404).type('text').send('Not found');
  if (file === 'admin.html') return res.status(status).set('Cache-Control', 'no-cache').type('html').send(html);
  // Public pages: fill in the website text and hand the scripts their words.
  // The home page also gets its header video (or first photo) in the HTML,
  // so it starts loading at once instead of after the page's scripts run.
  // ?rnbedit=1 is the admin panel's Website text preview: every piece of text
  // can be tapped to edit it (public/js/edit-mode.js). It only adds markers;
  // saving still needs an admin login. &hero=0 leaves out the header video.
  const q = (res.req && res.req.query) || {};
  const edit = q.rnbedit === '1';
  const heroMedia = file !== 'index.html' || (edit && q.hero === '0') ? Promise.resolve('')
    : heroCache && heroCache.exp > Date.now() ? Promise.resolve(heroCache.html)
    : pool.query("SELECT id, mime FROM media WHERE category = 'site' AND slot = 'hero' ORDER BY created_at, id")
      .then(({ rows }) => {
        const video = rows.find((r) => r.mime.startsWith('video/'));
        if (video) {
          return `<div class="slides" aria-hidden="true" data-ssr-video="${video.id}"><video class="slide on" src="/media/${video.id}" autoplay muted loop playsinline preload="auto" disablepictureinpicture></video></div>`;
        }
        return rows[0] ? `<div class="slides" aria-hidden="true"><div class="slide on" style="background-image:url('/media/${rows[0].id}.webp')"></div></div>` : '';
      }).then((html) => { heroCache = { html, exp: Date.now() + API_TTL }; return html; }).catch(() => '');
  const req = res.req;
  const seoKey = `${file}|${req.path}`;
  const seoHead = edit ? Promise.resolve(null)
    : seoCache.has(seoKey) && seoCache.get(seoKey).exp > Date.now() ? Promise.resolve(seoCache.get(seoKey).head)
    : savedContent().then((saved) => seo.head(file, req, saved)).then((head) => {
      if (seoCache.size > 300) seoCache.clear();
      seoCache.set(seoKey, { head, exp: Date.now() + API_TTL });
      return head;
    }).catch((err) => { console.warn('[seo]', err.message); return null; });
  Promise.all([savedContent().catch(() => ({})), heroMedia, seoHead]).then(([saved, hero, head]) => {
    const json = JSON.stringify(content.clientText(saved)).replace(/</g, '\\u003c');
    let out = content.fillPage(html, saved, { edit })
      .replace('<section class="hero"><!--HERO_MEDIA-->', hero ? `<section class="hero has-slides">${hero}` : '<section class="hero">')
      .replace('<script src="/js/common.js', `<script id="rnb-text" type="application/json">${json}</script>\n${edit ? '<script>window.RNB_EDIT = true;</script>\n' : ''}<script src="/js/common.js`);
    if (head) {
      const e = seo.esc;
      let extra = head.tags.join('\n');
      if (head.title) {
        out = out.replace(/<title>[^<]*<\/title>/, `<title>${e(head.title)}</title>`);
        extra += `\n<meta property="og:title" content="${e(head.title)}">`;
      }
      if (head.description) {
        out = out.replace(/<meta name="description"[^>]*>\n?/, '');
        extra += `\n<meta name="description" content="${e(head.description)}">\n<meta property="og:description" content="${e(head.description)}">`;
      }
      if (head.image) extra += `\n<meta property="og:image" content="${e(head.image)}">\n<meta name="twitter:card" content="summary_large_image">`;
      out = out.replace('</head>', `${extra}\n</head>`);
      // Event lists and event details as plain HTML (scripts redraw them).
      for (const [id, html] of Object.entries(head.lists || {})) {
        if (html) out = out.replace(new RegExp(`(<div[^>]*id="${id}"[^>]*>)[\\s\\S]*?(</div>)`), `$1${html}$2`);
      }
    }
    if (edit) {
      out = out.replace('</body>', `<script src="/js/edit-mode.js?v=${assetVersion('/js/edit-mode.js')}"></script>\n</body>`)
        .replace('<head>', '<head>\n<meta name="robots" content="noindex">');
    }
    res.status(status).set('Cache-Control', 'no-cache').type('html').send(out);
  });
}

const PAGES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/admin': 'admin.html', '/events': 'events.html', '/gallery': 'gallery.html', '/shop': 'shop.html',
  '/terms': 'terms.html', '/privacy': 'privacy.html', '/returns': 'returns.html',
  '/events.html': 'events.html', '/gallery.html': 'gallery.html', '/admin.html': 'admin.html', '/event.html': 'event.html',
};
for (const [route, file] of Object.entries(PAGES)) app.get(route, (req, res) => sendPage(res, file));
app.get('/events/:id', (req, res) => sendPage(res, 'event.html'));
// Pages are only sent through sendPage (which fills in their text).
app.use((req, res, next) => (/\.html$/i.test(req.path) ? next(httpError(404, 'Not found.')) : next()));

app.use((req, res, next) => next(httpError(404, 'Not found.')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE'
      ? (/^\/api\/admin\/(slots|photos\/\d+\/replace)/.test(req.path) ? `Each file must be under 15 MB (videos: ${VIDEO_MAX_MB} MB).` : 'Each photo must be under 15 MB.')
      : 'Upload failed: too many files.';
  }
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    message = 'Something went wrong on our side. Please try again.';
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) {
    if (err.code === 'duplicate_event') return res.status(status).json({ error: message, code: err.code, duplicate: err.duplicate });
    return res.status(status).json(err.code === 'must_change' ? { error: message, code: err.code } : { error: message });
  }
  sendPage(res, '404.html', status);
});

jobs.configure({ assertRoom: assertRoomFor, changed: clearPublicCache });
megaticket.configure({ assertRoom: assertRoomFor, changed: clearPublicCache });

module.exports = { app, clearPublicCache };

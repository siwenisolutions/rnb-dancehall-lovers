'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { pool, migrate, insertMedia, forgetMediaFiles, moveMediaToBucket, sweepOrphanFiles, compressStoredPhotos, SETTING_DEFAULTS, SLOTS, SLOT_MAX } = require('./db');
const storage = require('./storage');
const jobs = require('./jobs');
const { compressPendingVideos } = jobs;
const drive = require('./drive');
const { processImage, detectVideo } = require('./images');
const { importPost } = require('./social');
const auth = require('./auth');
const content = require('./content');

const PORT = process.env.PORT || 3000;
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
  throw new Error('SESSION_SECRET (32+ chars) must be set');
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

// Old onrender.com address and www. both forward to the main domain once it is set.
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
app.use((req, res, next) => {
  if (CANONICAL_HOST && req.hostname !== CANONICAL_HOST && req.path !== '/healthz' && req.path !== '/ping') {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// Keep-awake target: answers without touching the database, so the
// pings below don't keep waking the Postgres server too.
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
const eventColumns = `e.id, e.title, e.venue, e.starts_at, e.description, e.ticket_url, e.cover_media_id,
  (SELECT count(*)::int FROM media m WHERE m.event_id = e.id) AS photo_count,
  ARRAY(SELECT m.id FROM media m WHERE m.event_id = e.id
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

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// "Tickets on sale": every upcoming event with a ticket link (from the Events
// page), plus the two ticket cards from Website details while their event
// date hasn't passed. Soonest first; at most 4. Past tickets never show.
const TICKETS_MAX = 4;
async function ticketsOnSale(settings) {
  const { rows } = await pool.query(
    `SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} AND e.ticket_url <> '' ORDER BY e.starts_at ASC LIMIT ${TICKETS_MAX}`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Harare' }).format(new Date()); // YYYY-MM-DD
  const out = rows.map((e) => ({
    kind: 'event', event_id: e.id, title: e.title, venue: e.venue, starts_at: e.starts_at, url: e.ticket_url,
    photo_ids: e.photo_ids, sort: new Date(e.starts_at).getTime(),
  }));
  const eventUrls = new Set(out.map((t) => t.url));
  for (const n of [1, 2]) {
    const url = settings[`ticket${n}_url`];
    const date = settings[`ticket${n}_date`];
    if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || eventUrls.has(url)) continue;
    out.push({
      kind: 'card', card: n, title: settings[`ticket${n}_title`], subtitle: settings[`ticket${n}_subtitle`],
      label: settings[`ticket${n}_label`], date, url, sort: new Date(`${date}T23:59:00+02:00`).getTime(),
    });
  }
  return out.sort((a, b) => a.sort - b.sort).slice(0, TICKETS_MAX).map(({ sort, ...t }) => t);
}

// ---------- caching for busy times ----------
// Public answers are kept in memory for 2 minutes, photo details for good,
// and photo/video files on the server's disk. A crowd of visitors then costs
// a handful of database queries instead of one per visitor, which keeps the
// free database (100 compute hours and 5 GB of downloads a month) alive.
// Anything the admin changes clears the memory straight away.
const API_TTL = 2 * 60 * 1000;
const apiCache = new Map();
const mediaMeta = new Map();
let heroCache = null;
function clearPublicCache() {
  apiCache.clear();
  mediaMeta.clear();
  heroCache = null;
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
app.use(['/api/home', '/api/settings', '/api/events', '/api/photos'], cachedApi);

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
  res.json({ settings, upcoming: upcoming.rows, past: past.rows, slots, tickets });
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
};
const AUTO_PER_SLOT = 3;
async function fillFromLatestEvent(out) {
  const { rows } = await pool.query(
    `SELECT m.id, m.mime, m.width, m.height FROM media m
      WHERE m.event_id = (
        SELECT e.id FROM events e
         WHERE e.starts_at <= now() AND EXISTS (SELECT 1 FROM media x WHERE x.event_id = e.id AND x.mime LIKE 'image/%')
         ORDER BY e.starts_at DESC LIMIT 1)
        AND m.mime LIKE 'image/%'
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
    if (slot.startsWith('ticket') && out[slot].length) continue;
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
    'SELECT id, caption, width, height FROM media WHERE event_id = $1 ORDER BY created_at DESC, id DESC',
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
    '': "m.mime LIKE 'image/%'",
    event: "m.category = 'event'",
    experience: "m.slot IN ('exp1', 'exp2', 'exp3')",
    gallery: "m.mime LIKE 'image/%' AND m.category <> 'event' AND (m.slot IS NULL OR m.slot NOT IN ('exp1', 'exp2', 'exp3'))",
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

// Photos are immutable once uploaded (edits create new ids), so cache hard.
app.get('/media/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  let meta = mediaMeta.get(id);
  if (!meta) {
    const head = await pool.query('SELECT mime, in_bucket, COALESCE(bytes, octet_length(data)) AS size FROM media WHERE id = $1', [id]);
    if (head.rowCount === 0) throw httpError(404, 'Photo not found.');
    meta = { mime: head.rows[0].mime, inBucket: head.rows[0].in_bucket, size: Number(head.rows[0].size) };
    mediaMeta.set(id, meta);
    if (mediaMeta.size > 20000) mediaMeta.delete(mediaMeta.keys().next().value);
  }
  const { mime, inBucket, size } = meta;
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' });

  if (inBucket) return sendFromBucket(req, res, id, mime, size);

  if (mime.startsWith('video/')) {
    // Videos are sent in pieces so they start playing quickly and can be skipped through.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('Range') || '');
    let start = 0;
    let end = Math.min(size - 1, 2 * 1024 * 1024 - 1);
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : Math.min(size - 1, start + 2 * 1024 * 1024 - 1); }
      if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    } else {
      end = size - 1;
    }
    const { rows } = await pool.query('SELECT substring(data FROM $2 FOR $3) AS chunk FROM media WHERE id = $1', [id, start + 1, end - start + 1]);
    res.status(m ? 206 : 200).set({ 'Content-Type': mime, 'Content-Length': String(end - start + 1) });
    if (m) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    return res.send(rows[0].chunk);
  }

  const col = req.query.size === 'thumb' ? 'thumb' : 'data';
  const { rows } = await pool.query(`SELECT ${col} AS bytes FROM media WHERE id = $1`, [id]);
  res.set('Content-Type', mime).send(rows[0].bytes);
}));

// Files from object storage are kept on the server's disk after the first
// visitor asks for them, so later visitors don't download them from Neon again.
const DISK_CACHE = path.join(require('os').tmpdir(), 'rnb-media-cache');
const DISK_CACHE_MAX = 2 * 1024 * 1024 * 1024;
let diskCacheBytes = 0;
const fetching = new Map();
try { fs.rmSync(DISK_CACHE, { recursive: true, force: true }); fs.mkdirSync(DISK_CACHE, { recursive: true }); } catch { /* cache stays off */ }
function cachedFile(id, thumb) {
  const file = path.join(DISK_CACHE, `${id}-${thumb ? 'thumb' : 'full'}`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (diskCacheBytes > DISK_CACHE_MAX) return Promise.resolve(null);
  if (fetching.has(file)) return fetching.get(file);
  const p = (async () => {
    const part = `${file}.${process.pid}.part`;
    try {
      const { body } = await storage.getMedia(id, { thumb });
      await require('stream/promises').pipeline(body, fs.createWriteStream(part));
      diskCacheBytes += fs.statSync(part).size;
      fs.renameSync(part, file);
      return file;
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    } finally {
      fetching.delete(file);
    }
  })();
  fetching.set(file, p);
  return p;
}

// Sends a photo or video (or the requested piece of a video) from object storage.
async function sendFromBucket(req, res, id, mime, size) {
  const wantThumb = !mime.startsWith('video/') && req.query.size === 'thumb';
  let local = null;
  try {
    local = await cachedFile(id, wantThumb);
  } catch (err) {
    if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) throw httpError(404, 'Photo not found.');
    console.warn(`[media] ${id}: disk cache skipped: ${err.message}`);
  }
  if (local) {
    // sendFile handles "Range" requests itself, so videos can be skipped through.
    return res.sendFile(local, { headers: { 'Content-Type': mime }, cacheControl: false, lastModified: false });
  }
  return streamFromBucket(req, res, id, mime, size);
}

async function streamFromBucket(req, res, id, mime, size) {
  const thumb = !mime.startsWith('video/') && req.query.size === 'thumb';
  let range;
  let status = 200;
  if (mime.startsWith('video/')) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('Range') || '');
    if (m) {
      let start, end;
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : Math.min(size - 1, start + 2 * 1024 * 1024 - 1); }
      if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      range = `bytes=${start}-${end}`;
      status = 206;
    }
  }
  let file;
  try {
    file = await storage.getMedia(id, { thumb, range });
  } catch (err) {
    if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) throw httpError(404, 'Photo not found.');
    throw err;
  }
  res.status(status).set({ 'Content-Type': mime, 'Content-Length': String(file.length) });
  if (status === 206) res.set('Content-Range', file.contentRange);
  file.body.on('error', () => res.destroy());
  req.on('close', () => { if (!res.writableEnded && file.body.destroy) file.body.destroy(); });
  file.body.pipe(res);
}

// ---------- admin API ----------

app.post('/api/admin/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (tooManyAttempts(req.ip)) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
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
    recordFailure(req.ip);
    if (a) {
      await pool.query(
        `UPDATE admins SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1`, [a.id, ACCOUNT_MAX_FAILS, LOCK_MINUTES]);
    }
    throw httpError(401, 'Wrong email or password.');
  }
  failedLogins.delete(req.ip);
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

let contentCache = null;
async function savedContent() {
  if (contentCache) return contentCache;
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'c:%'");
  const out = {};
  for (const r of rows) out[r.key.slice(2)] = r.value;
  contentCache = out;
  return out;
}

admin.get('/content', wrap(async (req, res) => {
  const saved = await savedContent();
  res.json({
    fields: content.FIELDS.map((f) => ({
      key: f.key, page: f.page, section: f.section, label: f.label, type: f.type, hint: f.hint || '',
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
  instagram_url: 'Instagram', facebook_url: 'Facebook', tiktok_url: 'TikTok', youtube_url: 'YouTube',
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
  };
}

admin.post('/events', wrap(async (req, res) => {
  const e = eventFromBody(req.body || {});
  const { rows } = await pool.query(
    `INSERT INTO events (title, venue, starts_at, description, ticket_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [e.title, e.venue, e.startsAt, e.description, e.ticketUrl]
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
      const { rows } = await client.query('INSERT INTO events (title, venue, starts_at) VALUES ($1, $2, $3) RETURNING id', [e.title, e.venue, e.startsAt]);
      await linkFolder(rows[0].id, cleanFolderId(item.folder_id), item.resource_key, cleanText(item.name, 200, 'Folder'), client);
      created.push(rows[0].id);
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
    `UPDATE events SET title = $1, venue = $2, starts_at = $3, description = $4, ticket_url = $5
     WHERE id = $6`,
    [e.title, e.venue, e.startsAt, e.description, e.ticketUrl, id]
  );
  if (r.rowCount === 0) throw httpError(404, 'Event not found.');
  res.json({ ok: true });
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
  res.json({ ok: true });
  // Their files in object storage are cleared once the upload grace time has passed.
  setTimeout(() => sweepOrphanFiles().catch((err) => console.warn('[storage] sweep failed:', err.message)), 16 * 60 * 1000).unref();
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
});

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
    const img = await processImage(file.buffer);
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

// Videos for the header can be bigger than photos.
const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB || 60);
const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_MB * 1024 * 1024, files: SLOT_MAX },
});

async function storageUsed() {
  const { rows } = await pool.query(`SELECT ${STORAGE_USED_SQL}::bigint AS b`);
  return Number(rows[0].b);
}
async function assertRoomFor(bytes) {
  if ((await storageUsed()) + bytes > STORAGE_LIMIT_BYTES * 0.98) {
    throw httpError(400, 'Your storage is full. Delete some old photos or videos first, or ask Siweni to upgrade your storage.');
  }
}

// Turns an uploaded file into something we can store: a resized photo, or a
// header video exactly as uploaded.
async function prepareUpload(file, allowVideo) {
  const video = detectVideo(file.buffer);
  if (video) {
    if (!allowVideo) throw httpError(400, 'Videos can only be used for the header background. Please choose a photo here.');
    return { mime: video, width: 0, height: 0, data: file.buffer, thumb: Buffer.alloc(0) };
  }
  if (file.size > 15 * 1024 * 1024) throw httpError(400, 'Each photo must be under 15 MB.');
  return processImage(file.buffer);
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
  res.status(201).json({ ids, compressing: prepared.some((img) => img.mime.startsWith('video/')) });
  startVideoCompression();
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
    res.status(201).json({ id: newId, compressing: img.mime.startsWith('video/') });
    startVideoCompression();
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

// ---------- pages & static files ----------

const PUBLIC = path.join(__dirname, 'public');

// Pages are sent with "?v=<content hash>" on their CSS/JS links, so a browser
// never pairs a new page with an old cached stylesheet or script.
const ASSET_LINK = /(href|src)="(\/(?:css|js)\/[^"?]+)"/g;
const assetVersions = new Map();
const pageCache = new Map();
function assetVersion(urlPath) {
  if (!assetVersions.has(urlPath) || !IS_PROD) {
    let v = '0';
    try {
      v = crypto.createHash('md5').update(fs.readFileSync(path.join(PUBLIC, urlPath))).digest('hex').slice(0, 10);
    } catch { /* missing file: leave unversioned */ }
    assetVersions.set(urlPath, v);
  }
  return assetVersions.get(urlPath);
}
function sendPage(res, file, status = 200) {
  let html = IS_PROD && pageCache.get(file);
  if (!html) {
    html = fs.readFileSync(path.join(PUBLIC, file), 'utf8')
      .replace(ASSET_LINK, (m, attr, p) => `${attr}="${p}?v=${assetVersion(p)}"`);
    if (IS_PROD) pageCache.set(file, html);
  }
  if (file === 'admin.html') return res.status(status).set('Cache-Control', 'no-cache').type('html').send(html);
  // Public pages: fill in the website text and hand the scripts their words.
  // The home page also gets its header video (or first photo) in the HTML,
  // so it starts loading at once instead of after the page's scripts run.
  const heroMedia = file !== 'index.html' ? Promise.resolve('')
    : heroCache && heroCache.exp > Date.now() ? Promise.resolve(heroCache.html)
    : pool.query("SELECT id, mime FROM media WHERE category = 'site' AND slot = 'hero' ORDER BY created_at, id")
      .then(({ rows }) => {
        const video = rows.find((r) => r.mime.startsWith('video/'));
        if (video) {
          return `<div class="slides" aria-hidden="true" data-ssr-video="${video.id}"><video class="slide on" src="/media/${video.id}" autoplay muted loop playsinline preload="auto" disablepictureinpicture></video></div>`;
        }
        return rows[0] ? `<div class="slides" aria-hidden="true"><div class="slide on" style="background-image:url('/media/${rows[0].id}')"></div></div>` : '';
      }).then((html) => { heroCache = { html, exp: Date.now() + API_TTL }; return html; }).catch(() => '');
  Promise.all([savedContent().catch(() => ({})), heroMedia]).then(([saved, hero]) => {
    const json = JSON.stringify(content.clientText(saved)).replace(/</g, '\\u003c');
    const out = content.fillPage(html, saved)
      .replace('<section class="hero"><!--HERO_MEDIA-->', hero ? `<section class="hero has-slides">${hero}` : '<section class="hero">')
      .replace('<script src="/js/common.js', `<script id="rnb-text" type="application/json">${json}</script>\n<script src="/js/common.js`);
    res.status(status).set('Cache-Control', 'no-cache').type('html').send(out);
  });
}

const PAGES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/admin': 'admin.html', '/events': 'events.html', '/gallery': 'gallery.html',
  '/events.html': 'events.html', '/gallery.html': 'gallery.html', '/admin.html': 'admin.html', '/event.html': 'event.html',
};
for (const [route, file] of Object.entries(PAGES)) app.get(route, (req, res) => sendPage(res, file));
app.get('/events/:id', (req, res) => sendPage(res, 'event.html'));
// Photos rarely change; CSS/JS are versioned by the pages and revalidated otherwise.
// Pages are only sent through sendPage (which fills in their text).
app.use((req, res, next) => (/\.html$/i.test(req.path) ? next(httpError(404, 'Not found.')) : next()));
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}img${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=86400');
    else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

app.use((req, res, next) => next(httpError(404, 'Not found.')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 15 MB.' : 'Upload failed: too many files.';
  }
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    message = 'Something went wrong on our side. Please try again.';
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) {
    return res.status(status).json(err.code === 'must_change' ? { error: message, code: err.code } : { error: message });
  }
  sendPage(res, '404.html', status);
});

// Render's free plan puts the site to sleep after 15 minutes without visitors,
// and the next visitor waits about a minute on a loading screen. Calling our
// own public address every 10 minutes counts as a visitor, so it stays awake.
// Free hours (750 a month) are shared with every free service in the Render
// workspace, so by default it only stays awake 06:00-24:00 Zimbabwe time
// (KEEP_AWAKE_HOURS="6-24"; "0-24" = always). Overnight it is allowed to sleep;
// the first visitor after 06:00 wakes it and the pings take over again.
// Render sets RENDER_EXTERNAL_URL itself; KEEP_AWAKE=off turns this off
// (for example on a paid plan, which never sleeps).
function awakeWindow(spec) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(spec || '').trim());
  const start = m ? Number(m[1]) : 6;
  const end = m ? Number(m[2]) : 24;
  return (start >= 0 && end <= 24 && start < end) ? { start, end } : { start: 6, end: 24 };
}

function hourInZimbabwe(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Africa/Harare' }).format(date));
}

function keepAwake() {
  const base = process.env.RENDER_EXTERNAL_URL;
  if (!base || process.env.KEEP_AWAKE === 'off') return;
  const url = `${base.replace(/\/$/, '')}/ping`;
  const minutes = Math.max(1, Number(process.env.KEEP_AWAKE_MINUTES) || 10);
  const { start, end } = awakeWindow(process.env.KEEP_AWAKE_HOURS);
  const timer = setInterval(() => {
    const hour = hourInZimbabwe();
    if (hour < start || hour >= end) return; // quiet hours: let it sleep
    fetch(url, { signal: AbortSignal.timeout(30000) })
      .then((r) => { if (!r.ok) console.warn(`[keep-awake] ${url} answered ${r.status}`); })
      .catch((err) => console.warn('[keep-awake] ping failed:', err.message));
  }, minutes * 60 * 1000);
  timer.unref();
  console.log(`[keep-awake] pinging ${url} every ${minutes} min, ${start}:00-${end}:00 Zimbabwe time`);
}

function startVideoCompression() {
  compressPendingVideos().catch((err) => console.error('[video] queue stopped:', err.message));
}

if (require.main === module) {
  migrate()
    .then(() => app.listen(PORT, () => {
      console.log(`RnB Dancehall Lovers running on port ${PORT}`);
      // Background work, one after the other: shrink old photos, move files
      // to object storage, tidy leftovers, then compress any waiting videos.
      compressStoredPhotos().catch((err) => console.error('[compress] failed:', err.message))
        .then(() => moveMediaToBucket()).catch((err) => console.error('[storage] move failed:', err.message))
        .then(() => sweepOrphanFiles()).catch((err) => console.warn('[storage] sweep failed:', err.message))
        .then(() => startVideoCompression())
        .then(() => jobs.resumeDriveImports()).catch((err) => console.error('[drive] resume failed:', err.message));
      jobs.configure({ assertRoom: assertRoomFor, changed: clearPublicCache });
      // Look for new photos in linked Google Drive folders every 6 hours.
      const sync = () => jobs.syncDriveFolders().catch((err) => console.warn('[drive] sync failed:', err.message));
      setTimeout(sync, 3 * 60 * 1000).unref();
      setInterval(sync, 6 * 3600 * 1000).unref();
      keepAwake();
    }))
    .catch((err) => {
      console.error('Startup failed:', err);
      process.exit(1);
    });
}

module.exports = { app, awakeWindow, hourInZimbabwe };

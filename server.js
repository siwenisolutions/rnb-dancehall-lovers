'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { pool, migrate, insertMedia, SETTING_DEFAULTS, SLOTS, SLOT_MAX } = require('./db');
const { processImage, detectVideo } = require('./images');
const { importPost } = require('./social');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
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
// Storage cap of the Neon project (its branch limit is 1 GiB on the current plan).
// The gauge measures the database's real size against this.
const STORAGE_LIMIT_BYTES = Number(process.env.STORAGE_LIMIT_MB || 1024) * 1024 * 1024;
// Real size of everything stored: all databases on the branch, as Neon counts it.
const STORAGE_USED_SQL = '(SELECT sum(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate)';

if (ADMIN_PASSWORD.length < 10 || SESSION_SECRET.length < 32) {
  throw new Error('ADMIN_PASSWORD (10+ chars) and SESSION_SECRET (32+ chars) must be set');
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
  if (CANONICAL_HOST && req.hostname !== CANONICAL_HOST && req.path !== '/healthz') {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

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

// ---------- admin sessions (HMAC-signed cookie, no server state) ----------

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function makeSession() {
  const payload = `admin.${Date.now() + SESSION_HOURS * 3600 * 1000}`;
  return `${payload}.${sign(payload)}`;
}

function validSession(token) {
  if (typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(token.slice(i + 1));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  const exp = Number(payload.split('.')[1]);
  return Number.isFinite(exp) && exp > Date.now();
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

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple in-memory brute-force guard: 10 failed logins per IP per 15 minutes.
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

function requireAdmin(req, res, next) {
  if (!validSession(readCookie(req, COOKIE))) return next(httpError(401, 'Please log in again.'));
  // Writes must come from our own admin page (custom header can't be sent cross-site
  // without a CORS preflight, which we never allow). SameSite=Strict covers the rest.
  if (req.method !== 'GET' && req.get('X-RNB-Admin') !== '1') {
    return next(httpError(403, 'Request blocked.'));
  }
  next();
}

// ---------- public API ----------

// photo_ids: up to 5 of the event's photos (cover first) for its slideshow card.
const eventColumns = `e.id, e.title, e.venue, e.starts_at, e.description, e.ticket_url, e.cover_media_id,
  (SELECT count(*)::int FROM media m WHERE m.event_id = e.id) AS photo_count,
  ARRAY(SELECT m.id FROM media m WHERE m.event_id = e.id
        ORDER BY (m.id = e.cover_media_id) DESC, m.created_at, m.id LIMIT ${SLOT_MAX}) AS photo_ids`;
// An event counts as "upcoming" until 12 hours after it starts.
const UPCOMING = "e.starts_at >= now() - interval '12 hours'";

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

app.get('/api/home', wrap(async (req, res) => {
  const [settings, upcoming, past, slots] = await Promise.all([
    getSettings(),
    pool.query(`SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} ORDER BY e.starts_at ASC LIMIT 3`),
    pool.query(`SELECT ${eventColumns} FROM events e WHERE NOT (${UPCOMING}) ORDER BY e.starts_at DESC LIMIT 8`),
    getSlots(),
  ]);
  res.json({ settings, upcoming: upcoming.rows, past: past.rows, slots });
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
  return out;
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
    `SELECT m.id, m.category, m.slot, m.caption, m.width, m.height, m.event_id, e.title AS event_title
       FROM media m LEFT JOIN events e ON e.id = m.event_id
       ${where}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $1 OFFSET $2`,
    params
  );
  res.json({ photos: rows.slice(0, limit), more: rows.length > limit });
}));

// Photos are immutable once uploaded (edits create new ids), so cache hard.
app.get('/media/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const head = await pool.query('SELECT mime, octet_length(data) AS size FROM media WHERE id = $1', [id]);
  if (head.rowCount === 0) throw httpError(404, 'Photo not found.');
  const { mime } = head.rows[0];
  const size = Number(head.rows[0].size);
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' });

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

// ---------- admin API ----------

app.post('/api/admin/login', express.json({ limit: '10kb' }), (req, res, next) => {
  if (tooManyAttempts(req.ip)) return next(httpError(429, 'Too many attempts. Try again in 15 minutes.'));
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !passwordMatches(password)) {
    recordFailure(req.ip);
    return next(httpError(401, 'Wrong password.'));
  }
  failedLogins.delete(req.ip);
  setSessionCookie(res, makeSession(), SESSION_HOURS * 3600);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ loggedIn: validSession(readCookie(req, COOKIE)) });
});

const admin = express.Router();
admin.use(requireAdmin);
admin.use(express.json({ limit: '100kb' }));

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
      (SELECT COALESCE(avg(octet_length(data) + octet_length(thumb)), 400000)::bigint FROM media WHERE mime LIKE 'image/%') AS avg_photo_bytes,
      ${STORAGE_USED_SQL}::bigint AS db_bytes`);
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
  ticket2_title: 'Ticket card 2 event name', ticket2_subtitle: 'Ticket card 2 where', ticket2_label: 'Ticket card 2 button text', ticket2_url: 'Ticket card 2 ticket website',
};

admin.put('/settings', wrap(async (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const key of EDITABLE_SETTINGS) {
    if (!(key in body)) continue;
    const label = SETTING_LABELS[key] || key;
    if (key.endsWith('_url')) updates[key] = cleanUrl(body[key], label);
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
  res.status(201).json({ ids });
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
    await client.query('DELETE FROM media WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(201).json({ id: newId });
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

admin.delete('/photos/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const r = await pool.query('DELETE FROM media WHERE id = $1', [id]);
  if (r.rowCount === 0) throw httpError(404, 'Photo not found.');
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
  res.status(status).set('Cache-Control', 'no-cache').type('html').send(html);
}

const PAGES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/admin': 'admin.html', '/events': 'events.html', '/gallery': 'gallery.html',
  '/events.html': 'events.html', '/gallery.html': 'gallery.html', '/admin.html': 'admin.html', '/event.html': 'event.html',
};
for (const [route, file] of Object.entries(PAGES)) app.get(route, (req, res) => sendPage(res, file));
app.get('/events/:id', (req, res) => sendPage(res, 'event.html'));
// Photos rarely change; CSS/JS are versioned by the pages and revalidated otherwise.
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
    return res.status(status).json({ error: message });
  }
  sendPage(res, '404.html', status);
});

if (require.main === module) {
  migrate()
    .then(() => app.listen(PORT, () => console.log(`RNB Dancehall Lovers running on port ${PORT}`)))
    .catch((err) => {
      console.error('Startup failed:', err);
      process.exit(1);
    });
}

module.exports = { app };

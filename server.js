'use strict';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { pool, migrate, insertMedia, SETTING_DEFAULTS } = require('./db');
const { processImage } = require('./images');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_HOURS = 12;
const COOKIE = 'rnb_admin';
const EDITABLE_SETTINGS = Object.keys(SETTING_DEFAULTS);
const CATEGORIES = ['experience', 'gallery', 'event'];
// Event times are entered and shown in Zimbabwe time (CAT, UTC+2, no DST).
const ZW_OFFSET = '+02:00';

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
  if (v.length > max) throw httpError(400, `${field} is too long (max ${max} characters).`);
  return v;
}

function cleanUrl(value, field) {
  const v = cleanText(value, 1000, field);
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    throw httpError(400, `${field} must be a full link starting with https://`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw httpError(400, `${field} must be a full link starting with https://`);
  }
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

const eventColumns = `e.id, e.title, e.venue, e.starts_at, e.description, e.ticket_url, e.cover_media_id,
  (SELECT count(*)::int FROM media m WHERE m.event_id = e.id) AS photo_count`;
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
  const [settings, upcoming, past, experience] = await Promise.all([
    getSettings(),
    pool.query(`SELECT ${eventColumns} FROM events e WHERE ${UPCOMING} ORDER BY e.starts_at ASC LIMIT 3`),
    pool.query(`SELECT ${eventColumns} FROM events e WHERE NOT (${UPCOMING}) ORDER BY e.starts_at DESC LIMIT 8`),
    pool.query("SELECT id, caption FROM media WHERE category = 'experience' ORDER BY created_at DESC, id DESC LIMIT 3"),
  ]);
  res.json({ settings, upcoming: upcoming.rows, past: past.rows, experience: experience.rows });
}));

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
  let where = '';
  if (category) {
    if (!CATEGORIES.includes(category)) throw httpError(400, 'Unknown category.');
    params.push(category);
    where = 'WHERE m.category = $3';
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.category, m.caption, m.width, m.height, m.event_id, e.title AS event_title
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
  const col = req.query.size === 'thumb' ? 'thumb' : 'data';
  const { rows } = await pool.query(`SELECT mime, ${col} AS bytes FROM media WHERE id = $1`, [id]);
  if (rows.length === 0) throw httpError(404, 'Photo not found.');
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(rows[0].bytes);
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

admin.put('/settings', wrap(async (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const key of EDITABLE_SETTINGS) {
    if (!(key in body)) continue;
    if (key.endsWith('_url')) updates[key] = cleanUrl(body[key], key.replace(/_/g, ' '));
    else if (key === 'contact_email') updates[key] = cleanEmail(body[key]);
    else updates[key] = cleanText(body[key], 2000, key.replace(/_/g, ' '));
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
    ticketUrl: cleanUrl(body.ticket_url, 'Ticket link'),
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
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/events', (req, res) => res.sendFile(path.join(PUBLIC, 'events.html')));
app.get('/events/:id', (req, res) => res.sendFile(path.join(PUBLIC, 'event.html')));
app.get('/gallery', (req, res) => res.sendFile(path.join(PUBLIC, 'gallery.html')));
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: '1h' }));

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
  res.status(status).sendFile(path.join(PUBLIC, '404.html'));
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

'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { processImage, recompress } = require('./images');
const storage = require('./storage');
const auth = require('./auth');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString,
  ssl: /sslmode=require|neon\.tech/.test(connectionString) ? true : false,
  max: 5,
});

// Text settings the client can edit from the admin panel. Defaults are what
// the site shows until they change them.
const SETTING_DEFAULTS = {
  hero_text: 'Our R&B and dancehall events transform every night into an unforgettable experience for artists, dancers, and fans.',
  about_text: "We believe the strongest connections happen on the dance floor. Since 2025, our R&B and dancehall events have brought Zimbabwe's best DJs, sound systems and artists together with fans who love the culture.",
  contact_email: 'rnbdancehalllovers@rnbdancehalllovers.co.zw',
  phone: '077 167 4200',
  address: '383 Glen Helen Way, Glen Lorne, Harare, Zimbabwe',
  instagram_url: 'https://www.instagram.com/rnbdancehalllovers/',
  facebook_url: '',
  tiktok_url: '',
  whatsapp_url: 'https://whatsapp.com/channel/0029Vb6xj0D47Xe6bVFhv92q',
  youtube_url: '',
  // Ticket cards on the home page (also used for the footer buttons).
  ticket1_title: '1 Year Anniversary',
  ticket1_subtitle: 'Zimbabwe · Megaticket',
  ticket1_label: 'Get Tickets',
  ticket1_url: 'https://www.megaticket.africa/events/rnb-dancehall-lovers-1-year-anniversary',
  ticket2_title: 'Old Is The New Vibe',
  ticket2_subtitle: 'South Africa · Sahwigate',
  ticket2_label: 'Get Tickets (South Africa)',
  ticket2_url: 'https://sahwigate.com/event/rb-dancehall-lovers-old-is-the-new-vibe',
  // Date of the event each ticket card sells (YYYY-MM-DD). A card shows until
  // the end of that day; a card with no date isn't shown.
  ticket1_date: '',
  ticket2_date: '',
  // Words on the three Experience cards.
  exp1_label: 'Personal',
  exp2_label: 'Captivating',
  exp3_label: 'Engaging',
};

// Every picture spot on the website. Each holds up to SLOT_MAX photos that
// play as a slideshow; the header can hold a video instead.
const SLOT_MAX = 5;
const SLOTS = {
  hero: { label: 'Header background', where: 'The big picture at the top of the home page', video: true, seed: 'p6.jpg' },
  ticket1: { label: 'Ticket card 1', where: 'Tickets on sale, first card', seed: 'p12.jpg' },
  ticket2: { label: 'Ticket card 2', where: 'Tickets on sale, second card', seed: 'p5.jpg' },
  exp1: { label: 'Experience card 1', where: 'The Experience, left card', seed: 'p9.jpg' },
  exp2: { label: 'Experience card 2', where: 'The Experience, middle card', seed: 'p8.jpg' },
  exp3: { label: 'Experience card 3', where: 'The Experience, right card', seed: 'p10.jpg' },
  promo: { label: 'Any vibe, any night', where: 'Next to the pink "Any vibe, any night" banner', seed: 'p3.jpg' },
  join1: { label: 'Join us · Book your night', where: 'Bottom of the home page, left panel', seed: 'p1.jpg' },
  join2: { label: 'Our events · See the photos', where: 'Bottom of the home page, right panel', seed: 'p13.jpg' },
  intro1: { label: 'Old is the new vibe card', where: 'First card under the header, behind "Old is the new vibe"' },
  intro2: { label: 'More than music card', where: 'Second card under the header, behind "More than music"' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Admin panel logins. session_version goes up when the password changes or
-- someone chooses "sign out everywhere", which ends every older session.
CREATE TABLE IF NOT EXISTS admins (
  id              serial PRIMARY KEY,
  email           text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 200),
  name            text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  password_hash   text NOT NULL,
  must_change     boolean NOT NULL DEFAULT true,
  session_version integer NOT NULL DEFAULT 1,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  password_changed_at timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Temporary logins stop working at expires_at unless the person has chosen
-- their own email and password by then (that clears it).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Visitor counts (no cookies, nothing personal kept). A visitor is a daily
-- scrambled code made from their address and browser, so the same person on
-- the same day counts once; the code can't be turned back into the address.
CREATE TABLE IF NOT EXISTS visit_views (
  day   date NOT NULL,
  path  text NOT NULL,
  views integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
CREATE TABLE IF NOT EXISTS visit_visitors (
  day     date NOT NULL,
  visitor text NOT NULL,
  PRIMARY KEY (day, visitor)
);
CREATE TABLE IF NOT EXISTS visit_sources (
  day    date NOT NULL,
  source text NOT NULL,
  visits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

CREATE TABLE IF NOT EXISTS events (
  id          serial PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  venue       text NOT NULL DEFAULT '',
  starts_at   timestamptz NOT NULL,
  description text NOT NULL DEFAULT '',
  ticket_url  text NOT NULL DEFAULT '',
  cover_media_id integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_starts_at_idx ON events (starts_at);

CREATE TABLE IF NOT EXISTS media (
  id         serial PRIMARY KEY,
  category   text NOT NULL,
  event_id   integer REFERENCES events(id) ON DELETE CASCADE,
  caption    text NOT NULL DEFAULT '',
  mime       text NOT NULL,
  width      integer NOT NULL,
  height     integer NOT NULL,
  data       bytea NOT NULL,
  thumb      bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_category_idx ON media (category, created_at DESC);
CREATE INDEX IF NOT EXISTS media_event_idx ON media (event_id);

-- slot = which picture spot on the website a 'site' photo/video belongs to.
ALTER TABLE media ADD COLUMN IF NOT EXISTS slot text;
CREATE INDEX IF NOT EXISTS media_slot_idx ON media (slot, created_at);
-- Store files uncompressed so videos can be streamed in pieces.
ALTER TABLE media ALTER COLUMN data SET STORAGE EXTERNAL;

-- Files can live in object storage instead of the database (in_bucket).
-- bytes/thumb_bytes are the file sizes wherever the files are.
-- video_state: 'pending' (waiting to be compressed), 'done', 'failed'.
ALTER TABLE media ADD COLUMN IF NOT EXISTS in_bucket boolean NOT NULL DEFAULT false;
ALTER TABLE media ADD COLUMN IF NOT EXISTS bytes bigint;
ALTER TABLE media ADD COLUMN IF NOT EXISTS thumb_bytes bigint;
ALTER TABLE media ADD COLUMN IF NOT EXISTS video_state text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS video_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE media ALTER COLUMN data DROP NOT NULL;
ALTER TABLE media ALTER COLUMN thumb DROP NOT NULL;
UPDATE media SET bytes = octet_length(data), thumb_bytes = octet_length(thumb)
  WHERE bytes IS NULL AND data IS NOT NULL;
UPDATE media SET video_state = 'pending' WHERE mime LIKE 'video/%' AND video_state IS NULL;
-- source: where an imported photo came from ('drive:<file id>'), so the
-- same Drive photo is never added to an event twice.
ALTER TABLE media ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS media_event_source_idx ON media (event_id, source) WHERE source IS NOT NULL;

-- An event can be linked to a Google Drive folder; new photos put in that
-- folder are copied to the event automatically.
ALTER TABLE events ADD COLUMN IF NOT EXISTS drive_folder text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS drive_resource_key text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS drive_name text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS drive_synced_at timestamptz;
-- Table bookings: a second link next to "Get Tickets" (with its own flyer).
ALTER TABLE events ADD COLUMN IF NOT EXISTS tables_url text NOT NULL DEFAULT '';
-- Events found on Megaticket (see megaticket.js). A slug once seen is never
-- added again, so an event the admin deleted stays deleted.
ALTER TABLE events ADD COLUMN IF NOT EXISTS megaticket_slug text;
CREATE TABLE IF NOT EXISTS megaticket_seen (
  slug       text PRIMARY KEY,
  event_id   integer,
  seen_at    timestamptz NOT NULL DEFAULT now()
);

-- Copying photos from Google Drive, one job per event and folder.
-- status: pending, running, done, failed.
CREATE TABLE IF NOT EXISTS drive_imports (
  id          serial PRIMARY KEY,
  event_id    integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  folder_id   text NOT NULL,
  resource_key text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending',
  total       integer NOT NULL DEFAULT 0,
  added       integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  error       text NOT NULL DEFAULT '',
  automatic   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS drive_imports_status_idx ON drive_imports (status, id);
-- Drive photos the admin deleted or replaced on the website: never copied again.
CREATE TABLE IF NOT EXISTS drive_removed (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source   text NOT NULL,
  PRIMARY KEY (event_id, source)
);

CREATE INDEX IF NOT EXISTS media_video_state_idx ON media (video_state) WHERE video_state = 'pending';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_category_check' AND pg_get_constraintdef(oid) LIKE '%flyer%'
  ) THEN
    ALTER TABLE media DROP CONSTRAINT IF EXISTS media_category_check;
    ALTER TABLE media ADD CONSTRAINT media_category_check
      CHECK (category IN ('experience', 'gallery', 'event', 'site', 'flyer'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_cover_media_fk') THEN
    ALTER TABLE events ADD CONSTRAINT events_cover_media_fk
      FOREIGN KEY (cover_media_id) REFERENCES media(id) ON DELETE SET NULL;
  END IF;
END $$;
`;

// The photos that were embedded in the original single-page site. They are
// loaded into the database once so the client can manage them like any other.
const SEED_PHOTOS = [
  ['p9.jpg', 'experience', 'Personal'],
  ['p8.jpg', 'experience', 'Captivating'],
  ['p10.jpg', 'experience', 'Engaging'],
  ['p1.jpg', 'gallery', ''],
  ['p2.jpg', 'gallery', ''],
  ['p3.jpg', 'gallery', 'Live Set'],
  ['p4.jpg', 'gallery', 'Crew Links'],
  ['p5.jpg', 'gallery', 'Packed Out'],
  ['p6.jpg', 'gallery', 'Crowd Favorites'],
  ['p7.jpg', 'gallery', 'Photo Wall'],
  ['p11.jpg', 'gallery', ''],
  ['p12.jpg', 'gallery', ''],
  ['p13.jpg', 'gallery', ''],
];

async function migrate() {
  await pool.query(SCHEMA);
  await setUpAdmin();
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }
  const dir = path.join(__dirname, 'public', 'img');
  const seeded = await pool.query("SELECT value FROM settings WHERE key = '_photos_seeded'");
  if (seeded.rowCount === 0) {
    // Oldest first, so the experience photos keep their original order.
    for (const [file, category, caption] of SEED_PHOTOS.slice().reverse()) {
      const img = await processImage(fs.readFileSync(path.join(dir, file)));
      await insertMedia({ category, caption, eventId: null, img });
    }
    await pool.query("INSERT INTO settings (key, value) VALUES ('_photos_seeded', 'yes')");
  }

  // One-time move to picture sections ("slots"), keeping what is already there.
  const slotted = await pool.query("SELECT value FROM settings WHERE key = '_slots_seeded'");
  if (slotted.rowCount === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Experience photos become the three Experience cards (matched by their word).
      const exp = await client.query("SELECT id, caption FROM media WHERE category = 'experience' ORDER BY created_at, id");
      const byWord = { personal: 'exp1', captivating: 'exp2', engaging: 'exp3' };
      const free = ['exp1', 'exp2', 'exp3'];
      for (const row of exp.rows) {
        let slot = byWord[row.caption.trim().toLowerCase()];
        if (!slot || !free.includes(slot)) slot = free[0] || 'exp1';
        free.splice(free.indexOf(slot), 1);
        await client.query("UPDATE media SET category = 'site', slot = $1 WHERE id = $2", [slot, row.id]);
      }
      // Ticket thumbnails uploaded with the earlier version become ticket card photos.
      for (const n of ['1', '2']) {
        const r = await client.query('SELECT value FROM settings WHERE key = $1', [`ticket${n}_image`]);
        const id = Number(r.rows[0] && r.rows[0].value);
        if (Number.isInteger(id) && id > 0) {
          await client.query("UPDATE media SET category = 'site', slot = $1 WHERE id = $2 AND category = 'site'", [`ticket${n}`, id]);
        }
      }
      await client.query("DELETE FROM settings WHERE key IN ('ticket1_image', 'ticket2_image')");
      await client.query("INSERT INTO settings (key, value) VALUES ('_slots_seeded', 'yes')");
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // Any section that is still empty starts with the photo the site was built with.
  for (const [slot, def] of Object.entries(SLOTS)) {
    const has = await pool.query('SELECT 1 FROM media WHERE slot = $1 LIMIT 1', [slot]);
    const done = await pool.query('SELECT 1 FROM settings WHERE key = $1', [`_slot_seed_${slot}`]);
    if (has.rowCount === 0 && done.rowCount === 0 && def.seed) {
      const img = await processImage(fs.readFileSync(path.join(dir, def.seed)));
      await insertMedia({ category: 'site', caption: '', eventId: null, img, slot });
    }
    // Remember it was seeded, so a section the client empties on purpose stays empty.
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, 'yes') ON CONFLICT (key) DO NOTHING", [`_slot_seed_${slot}`]);
  }
  await installHeaderVideo();
}

// One-time swap of the header background for the video the client sent in
// November 2026 (seed/hero-2026-11.mp4, already compressed for phones). The
// old header video and photo are removed. Runs once; after that the header
// is managed from the admin panel as usual.
const HEADER_VIDEO = { key: '_hero_video_2026_11', file: path.join(__dirname, 'seed', 'hero-2026-11.mp4') };
async function installHeaderVideo() {
  const done = await pool.query('SELECT 1 FROM settings WHERE key = $1', [HEADER_VIDEO.key]);
  if (done.rowCount || !fs.existsSync(HEADER_VIDEO.file)) return;
  const data = fs.readFileSync(HEADER_VIDEO.file);
  const client = await pool.connect();
  let oldIds = [];
  try {
    await client.query('BEGIN');
    const old = await client.query("SELECT id FROM media WHERE category = 'site' AND slot = 'hero'");
    oldIds = old.rows.map((r) => r.id);
    await insertMedia({
      category: 'site', caption: '', eventId: null, slot: 'hero',
      img: { mime: 'video/mp4', width: 0, height: 0, data, thumb: Buffer.alloc(0), videoState: 'done' },
    }, client);
    if (oldIds.length) await client.query('DELETE FROM media WHERE id = ANY($1::int[])', [oldIds]);
    await client.query("INSERT INTO settings (key, value) VALUES ($1, 'yes')", [HEADER_VIDEO.key]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[hero] new header video not installed yet:', err.message);
    return;
  } finally {
    client.release();
  }
  for (const id of oldIds) forgetMediaFiles(id);
  console.log(`[hero] header video replaced (removed media ${oldIds.join(', ') || 'none'})`);
}

// Saves a photo or video. With object storage set up, the file goes to the
// bucket and the database keeps only its details.
// First start: the admin account gets the site's contact email (or
// ADMIN_EMAIL) and the old shared ADMIN_PASSWORD, and must pick its own
// password at first login. ADMIN_RESET_PASSWORD (set on Render) resets a
// forgotten password once; remove it again afterwards.
async function setUpAdmin() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM admins');
  if (rows[0].n === 0) {
    const pw = process.env.ADMIN_PASSWORD || '';
    if (pw.length < 10) throw new Error('No admin account yet: set ADMIN_PASSWORD (10+ characters) for the first login.');
    const r = await pool.query("SELECT value FROM settings WHERE key = 'contact_email'");
    const email = auth.normaliseEmail(process.env.ADMIN_EMAIL || (r.rows[0] && r.rows[0].value) || SETTING_DEFAULTS.contact_email);
    await pool.query('INSERT INTO admins (email, password_hash, must_change) VALUES ($1, $2, true)',
      [email, await auth.hashPassword(pw)]);
    console.log(`[admin] created the admin login for ${email}; they will choose their own password at first login`);
  }
  const reset = process.env.ADMIN_RESET_PASSWORD || '';
  if (reset) {
    if (reset.length < 10) { console.warn('[admin] ADMIN_RESET_PASSWORD ignored: use 10+ characters'); return; }
    const tag = crypto.createHash('sha256').update(reset).digest('hex');
    const done = await pool.query("SELECT 1 FROM settings WHERE key = '_admin_reset' AND value = $1", [tag]);
    if (done.rowCount) return; // this reset was already used
    const email = auth.normaliseEmail(process.env.ADMIN_RESET_EMAIL || '');
    const target = email
      ? await pool.query('SELECT id, email FROM admins WHERE email = $1', [email])
      : await pool.query('SELECT id, email FROM admins ORDER BY id LIMIT 1');
    if (!target.rowCount) { console.warn(`[admin] ADMIN_RESET_PASSWORD: no admin ${email}`); return; }
    await pool.query(
      `UPDATE admins SET password_hash = $2, must_change = true, session_version = session_version + 1,
              failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [target.rows[0].id, await auth.hashPassword(reset)]);
    await pool.query("INSERT INTO settings (key, value) VALUES ('_admin_reset', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [tag]);
    console.log(`[admin] password reset for ${target.rows[0].email}. Remove ADMIN_RESET_PASSWORD on Render now.`);
  }
}

async function insertMedia({ category, caption, eventId, img, slot = null, createdAt = null, source = null }, db = pool) {
  const inBucket = storage.enabled;
  const videoState = img.mime.startsWith('video/') ? (img.videoState || 'pending') : null;
  const { rows } = await db.query(
    `INSERT INTO media (category, event_id, caption, mime, width, height, data, thumb, slot, created_at,
                        in_bucket, bytes, thumb_bytes, video_state, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()), $11, $12, $13, $14, $15) RETURNING id`,
    [category, eventId, caption, img.mime, img.width, img.height,
      inBucket ? null : img.data, inBucket ? null : img.thumb, slot, createdAt,
      inBucket, img.data.length, img.thumb.length, videoState, source]
  );
  const id = rows[0].id;
  if (inBucket) await storage.putMedia(id, img);
  return id;
}

// Removes a file from object storage after its row is gone (never throws).
function forgetMediaFiles(id) {
  if (!storage.enabled) return;
  storage.deleteMedia(id).catch((err) => console.warn(`[storage] could not delete media ${id}:`, err.message));
}

// One-time (and resumable) move of files from the database to object storage.
async function moveMediaToBucket() {
  if (!storage.enabled) return;
  const { rows } = await pool.query('SELECT id FROM media WHERE NOT in_bucket ORDER BY id');
  if (!rows.length) return;
  let moved = 0, bytes = 0;
  for (const { id } of rows) {
    try {
      const r = await pool.query('SELECT mime, data, thumb FROM media WHERE id = $1 AND NOT in_bucket', [id]);
      if (!r.rowCount) continue;
      const { mime, data, thumb } = r.rows[0];
      await storage.putMedia(id, { mime, data, thumb: thumb || Buffer.alloc(0) });
      const u = await pool.query(
        'UPDATE media SET in_bucket = true, data = NULL, thumb = NULL, bytes = $2, thumb_bytes = $3 WHERE id = $1 AND NOT in_bucket',
        [id, data.length, thumb ? thumb.length : 0]);
      if (!u.rowCount) forgetMediaFiles(id); // deleted while it was being copied
      else { moved += 1; bytes += data.length + (thumb ? thumb.length : 0); }
    } catch (err) {
      console.error(`[storage] media ${id} not moved yet:`, err.message);
    }
  }
  console.log(`[storage] moved ${moved} of ${rows.length} files (${(bytes / 1048576).toFixed(1)} MB) to object storage`);
  if (moved) {
    // Give the freed database space back.
    await pool.query('VACUUM FULL media').catch((err) => console.warn('[storage] vacuum skipped:', err.message));
  }
}

// Deletes files in object storage whose photo or video no longer exists
// (for example after an event and its photos were deleted). Files younger
// than 15 minutes are left alone, as their upload may still be finishing.
async function sweepOrphanFiles() {
  if (!storage.enabled) return;
  const listed = await storage.listMedia();
  if (!listed.size) return;
  const { rows } = await pool.query('SELECT id FROM media WHERE in_bucket');
  const live = new Set(rows.map((r) => r.id));
  const cutoff = Date.now() - 15 * 60 * 1000;
  const keys = [];
  for (const [id, e] of listed) if (!live.has(id) && e.newest < cutoff) keys.push(...e.keys);
  if (keys.length) {
    await storage.deleteKeys(keys);
    console.log(`[storage] removed ${keys.length} leftover files`);
  }
}

// One-time pass that shrinks photos stored before the current compression
// settings. Runs in the background after start-up, one photo at a time.
async function compressStoredPhotos() {
  const done = await pool.query("SELECT 1 FROM settings WHERE key = '_media_compressed_v2'");
  if (done.rowCount) return;
  const { rows } = await pool.query("SELECT id FROM media WHERE mime LIKE 'image/%' AND data IS NOT NULL ORDER BY id");
  let saved = 0, changed = 0;
  for (const { id } of rows) {
    try {
      const r = await pool.query('SELECT data, thumb FROM media WHERE id = $1 AND data IS NOT NULL', [id]);
      if (!r.rowCount) continue;
      const { data, thumb } = r.rows[0];
      const out = await recompress(data, thumb);
      if (!out) continue;
      await pool.query('UPDATE media SET data = $1, thumb = $2, width = $3, height = $4, bytes = $6, thumb_bytes = $7 WHERE id = $5',
        [out.data, out.thumb, out.width, out.height, id, out.data.length, out.thumb.length]);
      saved += data.length + thumb.length - out.data.length - out.thumb.length;
      changed += 1;
    } catch (err) {
      console.error(`[compress] photo ${id} skipped:`, err.message);
    }
  }
  await pool.query("INSERT INTO settings (key, value) VALUES ('_media_compressed_v2', 'yes') ON CONFLICT (key) DO NOTHING");
  console.log(`[compress] ${changed} of ${rows.length} photos smaller, saved ${(saved / 1048576).toFixed(1)} MB`);
}

module.exports = { pool, migrate, insertMedia, forgetMediaFiles, moveMediaToBucket, sweepOrphanFiles, compressStoredPhotos, SETTING_DEFAULTS, SLOTS, SLOT_MAX };

'use strict';
// Database access on Cloudflare Workers (Neon serverless driver, over HTTPS).
// Each query is one HTTPS request: no connection to set up, nothing kept
// between requests (Workers don't allow a connection made in one request to
// be used in another), and it works through any network.
//
// pool.connect() hands back an object with the same query() so the code
// written for node-postgres keeps working. BEGIN / COMMIT / ROLLBACK are
// skipped: statements run one by one (each on its own is still atomic).
const crypto = require('crypto');
const { neon, neonConfig } = require('@neondatabase/serverless');
const storage = require('./storage');
const auth = require('./auth');

const connectionString = process.env.DATABASE_URL || '';

// Local testing only (tools/dev/local-services.js).
if (process.env.NEON_FETCH_ENDPOINT) neonConfig.fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;

let http = null;
function sql() {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  if (!http) http = neon(connectionString, { fullResults: true });
  return http;
}

const SKIP = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i;
const pool = {
  async query(text, params) {
    if (SKIP.test(text)) return { rows: [], rowCount: 0 };
    return sql().query(text, params || []);
  },
  async connect() {
    return { query: pool.query, release() {} };
  },
};

// Splits a block of SQL into statements (keeps DO $$ ... $$ blocks whole).
function statements(text) {
  const out = [];
  let cur = '';
  let inDollar = false;
  for (const line of text.split('\n')) {
    if (/^\s*--/.test(line) && !inDollar) continue;
    cur += line + '\n';
    const n = (line.match(/\$\$/g) || []).length;
    if (n % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(line)) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

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
  // Google Search Console's HTML-tag verification code (Details → Google).
  google_verification: '',
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
-- Merchandise shop (shop.js). Prices in US cents. sizes: one per line,
-- empty for one-size items.
CREATE TABLE IF NOT EXISTS products (
  id          serial PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents > 0 AND price_cents < 100000000),
  sizes       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE media ADD COLUMN IF NOT EXISTS product_id integer REFERENCES products(id) ON DELETE CASCADE;
-- A product can be listed before its price is set ("Price coming soon"); it can't be ordered until then.
ALTER TABLE products ALTER COLUMN price_cents DROP NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_cents_check;
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_price_ok CHECK (price_cents IS NULL OR (price_cents > 0 AND price_cents < 100000000));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS media_product_idx ON media (product_id) WHERE product_id IS NOT NULL;
-- Shop filters: a category (clothing, headwear, accessories, drinkware or empty)
-- and whether the item is in stock (sold-out items stay listed, greyed out).
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS in_stock boolean NOT NULL DEFAULT true;
-- status: pending (waiting for payment), paid, failed, cancelled, sent, delivered
CREATE TABLE IF NOT EXISTS orders (
  id           serial PRIMARY KEY,
  ref          text NOT NULL UNIQUE,
  name         text NOT NULL,
  phone        text NOT NULL,
  email        text NOT NULL DEFAULT '',
  city         text NOT NULL DEFAULT '',
  address      text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  items        jsonb NOT NULL,
  total_cents  integer NOT NULL,
  pay_method   text NOT NULL,
  pay_phone    text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'pending',
  paynow_poll_url text,
  paynow_ref   text,
  auth_code    text,
  auth_expires text,
  error        text,
  seen         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
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
-- People who asked for event updates on the website (with their consent).
CREATE TABLE IF NOT EXISTS contacts (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  phone        text NOT NULL DEFAULT '',
  email        text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'signup',
  interests    text[] NOT NULL DEFAULT '{}',
  consent      boolean NOT NULL DEFAULT false,
  consent_text text NOT NULL DEFAULT '',
  consent_at   timestamptz,
  page         text NOT NULL DEFAULT '',
  seen         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts (phone) WHERE phone <> '';
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (email) WHERE email <> '';

-- Drive photos the admin deleted or replaced on the website: never copied again.
CREATE TABLE IF NOT EXISTS drive_removed (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source   text NOT NULL,
  PRIMARY KEY (event_id, source)
);

-- Cloudflare: visitors seen in the last few minutes ("on the site now"),
-- and Drive imports that run in small steps (todo = photos still to copy).
ALTER TABLE visit_visitors ADD COLUMN IF NOT EXISTS last_seen timestamptz;
CREATE INDEX IF NOT EXISTS visit_visitors_seen_idx ON visit_visitors (last_seen);
ALTER TABLE drive_imports ADD COLUMN IF NOT EXISTS todo jsonb;
ALTER TABLE drive_imports ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS media_video_state_idx ON media (video_state) WHERE video_state = 'pending';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_category_check' AND pg_get_constraintdef(oid) LIKE '%product%'
  ) THEN
    ALTER TABLE media DROP CONSTRAINT IF EXISTS media_category_check;
    ALTER TABLE media ADD CONSTRAINT media_category_check
      CHECK (category IN ('experience', 'gallery', 'event', 'site', 'flyer', 'product'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_cover_media_fk') THEN
    ALTER TABLE events ADD CONSTRAINT events_cover_media_fk
      FOREIGN KEY (cover_media_id) REFERENCES media(id) ON DELETE SET NULL;
  END IF;
END $$;
`;

// Bump when SCHEMA changes: the daily job runs it again once.
const SCHEMA_VERSION = 'cf-4';

// Creates or updates tables, default settings and the first admin login.
// Runs from the scheduled job (and is cheap to repeat).
async function migrate({ force = false } = {}) {
  const client = await pool.connect();
  {
    if (!force) {
      const v = await client.query("SELECT value FROM settings WHERE key = '_schema_version'").catch(() => ({ rows: [] }));
      if (v.rows[0] && v.rows[0].value === SCHEMA_VERSION) {
        await setUpAdmin(client);
        return false;
      }
    }
    for (const st of statements(SCHEMA)) await client.query(st);
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      await client.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
    }
    await setUpAdmin(client);
    await client.query("INSERT INTO settings (key, value) VALUES ('_schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [SCHEMA_VERSION]);
    return true;
  }
}

// Saves a photo or video. With object storage set up, the file goes to the
// bucket and the database keeps only its details.
// First start: the admin account gets the site's contact email (or
// ADMIN_EMAIL) and the old shared ADMIN_PASSWORD, and must pick its own
// password at first login. ADMIN_RESET_PASSWORD (a Cloudflare secret) resets a
// forgotten password once; remove it again afterwards.
async function setUpAdmin(db = pool) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM admins');
  if (rows[0].n === 0) {
    const pw = process.env.ADMIN_PASSWORD || '';
    if (pw.length < 10) throw new Error('No admin account yet: set ADMIN_PASSWORD (10+ characters) for the first login.');
    const r = await db.query("SELECT value FROM settings WHERE key = 'contact_email'");
    const email = auth.normaliseEmail(process.env.ADMIN_EMAIL || (r.rows[0] && r.rows[0].value) || SETTING_DEFAULTS.contact_email);
    await db.query('INSERT INTO admins (email, password_hash, must_change) VALUES ($1, $2, true)',
      [email, await auth.hashPassword(pw)]);
    console.log(`[admin] created the admin login for ${email}; they will choose their own password at first login`);
  }
  const reset = process.env.ADMIN_RESET_PASSWORD || '';
  if (reset) {
    if (reset.length < 10) { console.warn('[admin] ADMIN_RESET_PASSWORD ignored: use 10+ characters'); return; }
    const tag = crypto.createHash('sha256').update(reset).digest('hex');
    const done = await db.query("SELECT 1 FROM settings WHERE key = '_admin_reset' AND value = $1", [tag]);
    if (done.rowCount) return; // this reset was already used
    const email = auth.normaliseEmail(process.env.ADMIN_RESET_EMAIL || '');
    const target = email
      ? await db.query('SELECT id, email FROM admins WHERE email = $1', [email])
      : await db.query('SELECT id, email FROM admins ORDER BY id LIMIT 1');
    if (!target.rowCount) { console.warn(`[admin] ADMIN_RESET_PASSWORD: no admin ${email}`); return; }
    await db.query(
      `UPDATE admins SET password_hash = $2, must_change = true, session_version = session_version + 1,
              failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [target.rows[0].id, await auth.hashPassword(reset)]);
    await db.query("INSERT INTO settings (key, value) VALUES ('_admin_reset', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [tag]);
    console.log(`[admin] password reset for ${target.rows[0].email}. Remove ADMIN_RESET_PASSWORD in Cloudflare now.`);
  }
}

async function insertMedia({ category, caption, eventId, img, slot = null, createdAt = null, source = null, productId = null }, db = pool) {
  if (!storage.enabled) throw new Error('Object storage is not set up (AWS_* settings).');
  const videoState = img.mime.startsWith('video/') ? (img.videoState || 'done') : null;
  const thumbLen = img.thumb ? img.thumb.length : 0;
  const { rows } = await db.query(
    `INSERT INTO media (category, event_id, caption, mime, width, height, slot, created_at,
                        in_bucket, bytes, thumb_bytes, video_state, source, product_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), true, $9, $10, $11, $12, $13) RETURNING id`,
    [category, eventId, caption, img.mime, img.width, img.height, slot, createdAt,
      img.data.length, thumbLen, videoState, source, productId]
  );
  const id = rows[0].id;
  try {
    await storage.putMedia(id, img);
  } catch (err) {
    await db.query('DELETE FROM media WHERE id = $1', [id]).catch(() => {});
    throw err;
  }
  return id;
}

// Removes a file from object storage after its row is gone (never throws).
// Keeps the Worker running until a background task has finished.
function later(promise) {
  if (globalThis.__waitUntil) globalThis.__waitUntil(promise);
  return promise;
}

function forgetMediaFiles(id) {
  if (!storage.enabled) return;
  later(storage.deleteMedia(id).catch((err) => console.warn(`[storage] could not delete media ${id}:`, err.message)));
}

// Deletes files in object storage whose photo or video no longer exists
// (for example after an event and its photos were deleted). Files younger
// than 15 minutes are left alone, as their upload may still be finishing.
async function sweepOrphanFiles({ max = 25 } = {}) {
  if (!storage.enabled) return;
  const listed = await storage.listMedia();
  if (!listed.size) return;
  const { rows } = await pool.query('SELECT id FROM media WHERE in_bucket');
  const live = new Set(rows.map((r) => r.id));
  const cutoff = Date.now() - 15 * 60 * 1000;
  const keys = [];
  for (const [id, e] of listed) if (!live.has(id) && e.newest < cutoff) keys.push(...e.keys);
  // A few per run: each delete is one outside request (the free plan allows 50 a run).
  const now = keys.slice(0, max);
  if (now.length) {
    await storage.deleteKeys(now);
    console.log(`[storage] removed ${now.length} leftover files${keys.length > now.length ? ` (${keys.length - now.length} next time)` : ''}`);
  }
}

module.exports = { statements, pool, migrate, insertMedia, forgetMediaFiles, sweepOrphanFiles, later, SETTING_DEFAULTS, SLOTS, SLOT_MAX };

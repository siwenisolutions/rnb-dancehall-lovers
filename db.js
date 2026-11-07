'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { processImage } = require('./images');

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
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_category_check' AND pg_get_constraintdef(oid) LIKE '%site%'
  ) THEN
    ALTER TABLE media DROP CONSTRAINT IF EXISTS media_category_check;
    ALTER TABLE media ADD CONSTRAINT media_category_check
      CHECK (category IN ('experience', 'gallery', 'event', 'site'));
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
    if (has.rowCount === 0 && done.rowCount === 0) {
      const img = await processImage(fs.readFileSync(path.join(dir, def.seed)));
      await insertMedia({ category: 'site', caption: '', eventId: null, img, slot });
    }
    // Remember it was seeded, so a section the client empties on purpose stays empty.
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, 'yes') ON CONFLICT (key) DO NOTHING", [`_slot_seed_${slot}`]);
  }
}

async function insertMedia({ category, caption, eventId, img, slot = null, createdAt = null }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO media (category, event_id, caption, mime, width, height, data, thumb, slot, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now())) RETURNING id`,
    [category, eventId, caption, img.mime, img.width, img.height, img.data, img.thumb, slot, createdAt]
  );
  return rows[0].id;
}

module.exports = { pool, migrate, insertMedia, SETTING_DEFAULTS, SLOTS, SLOT_MAX };

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
  // ticketN_image is a media id set by uploading a thumbnail in the admin panel.
  ticket1_title: '1 Year Anniversary',
  ticket1_subtitle: 'Zimbabwe · Megaticket',
  ticket1_label: 'Get Tickets',
  ticket1_url: 'https://www.megaticket.africa/events/rnb-dancehall-lovers-1-year-anniversary',
  ticket1_image: '',
  ticket2_title: 'Old Is The New Vibe',
  ticket2_subtitle: 'South Africa · Sahwigate',
  ticket2_label: 'Get Tickets (South Africa)',
  ticket2_url: 'https://sahwigate.com/event/rb-dancehall-lovers-old-is-the-new-vibe',
  ticket2_image: '',
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

-- 'site' = images used by the site itself (e.g. ticket card thumbnails), not shown in the gallery.
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
  const seeded = await pool.query("SELECT value FROM settings WHERE key = '_photos_seeded'");
  if (seeded.rowCount === 0) {
    const dir = path.join(__dirname, 'public', 'img');
    // Oldest first, so the experience photos keep their original order.
    for (const [file, category, caption] of SEED_PHOTOS.slice().reverse()) {
      const img = await processImage(fs.readFileSync(path.join(dir, file)));
      await insertMedia({ category, caption, eventId: null, img });
    }
    await pool.query("INSERT INTO settings (key, value) VALUES ('_photos_seeded', 'yes')");
  }
}

async function insertMedia({ category, caption, eventId, img }) {
  const { rows } = await pool.query(
    `INSERT INTO media (category, event_id, caption, mime, width, height, data, thumb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [category, eventId, caption, img.mime, img.width, img.height, img.data, img.thumb]
  );
  return rows[0].id;
}

module.exports = { pool, migrate, insertMedia, SETTING_DEFAULTS };

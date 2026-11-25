// Finds an event that is probably the same night as a new one, so the admin isn't
// left with two copies (e.g. one typed in, one brought in from Megaticket).
//
// Same night = the same calendar day in Harare, and a similar title or venue
// ("King's Kraal" ≈ "KINGS KRAAL, BULAWAYO"), or the same title within 2 days.

const TZ = 'Africa/Harare';
// Words every event shares, which say nothing about which night it is.
const COMMON = new Set(['the', 'and', 'rnb', 'dancehall', 'lovers', 'lover', 'presents', 'live', 'night',
  'edition', 'vol', 'with', 'are', 'you', 'ready', 'old', 'new', 'vibe', 'is']);

function words(text) {
  return new Set(String(text || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/@\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !COMMON.has(w)));
}

// Share of the smaller set's words found in the other (0..1).
function overlap(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit += 1;
  return hit / Math.min(x.size, y.size);
}

function day(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

function sameTitle(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return n(a) && n(a) === n(b);
}

async function findDuplicateEvent(db, { title, venue, startsAt, excludeId = null }) {
  const when = new Date(startsAt);
  if (Number.isNaN(when.getTime())) return null;
  const { rows } = await db.query(
    `SELECT id, title, venue, starts_at FROM events
      WHERE starts_at BETWEEN $1::timestamptz - interval '2 days' AND $1::timestamptz + interval '2 days'
        AND ($2::int IS NULL OR id <> $2::int)
      ORDER BY abs(extract(epoch FROM starts_at - $1::timestamptz))`,
    [when.toISOString(), excludeId]);
  for (const e of rows) {
    if (sameTitle(e.title, title)) return e;
    if (day(e.starts_at) !== day(when)) continue;
    if (overlap(e.title, title) >= 0.5 || overlap(e.venue, venue) >= 0.5 || (!e.venue && !venue)) return e;
  }
  return null;
}

module.exports = { findDuplicateEvent, overlap, words };

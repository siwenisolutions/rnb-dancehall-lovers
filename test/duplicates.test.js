const test = require('node:test');
const assert = require('node:assert');
const { findDuplicateEvent } = require('../duplicates');

// A tiny stand-in for the database: returns events within the query's ±2-day window.
function fakeDb(events) {
  return {
    query: async (_sql, [whenIso, excludeId]) => {
      const when = new Date(whenIso).getTime();
      return { rows: events.filter((e) => Math.abs(new Date(e.starts_at) - when) <= 2 * 86400000 && e.id !== excludeId) };
    },
  };
}
const existing = [
  { id: 2, title: 'Bulawayo, Are You Ready?', venue: 'KINGS KRAAL, BULAWAYO @kingskraalbulawayo', starts_at: '2026-12-12T11:00:00Z' },
  { id: 1, title: 'Harare', venue: 'The Backspace Lounge', starts_at: '2026-11-28T11:00:00Z' },
];

test('the same night typed differently is a duplicate', async () => {
  const dup = await findDuplicateEvent(fakeDb(existing), { title: "R'n'B Dancehall Lovers Bulawayo", venue: "King's Kraal", startsAt: '2026-12-12T09:00:00Z' });
  assert.equal(dup && dup.id, 2);
});

test('a different city on another day is not a duplicate', async () => {
  const dup = await findDuplicateEvent(fakeDb(existing), { title: 'Gweru', venue: 'Midlands Hotel', startsAt: '2026-12-13T18:00:00Z' });
  assert.equal(dup, null);
});

test('the same title a day apart is a duplicate', async () => {
  const dup = await findDuplicateEvent(fakeDb(existing), { title: 'Harare', venue: '', startsAt: '2026-11-29T18:00:00Z' });
  assert.equal(dup && dup.id, 1);
});

test('editing an event does not match itself', async () => {
  const dup = await findDuplicateEvent(fakeDb(existing), { title: 'Harare', venue: 'The Backspace Lounge', startsAt: '2026-11-28T11:00:00Z', excludeId: 1 });
  assert.equal(dup, null);
});

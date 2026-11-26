const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const contacts = require('../contacts');

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function cleanText(v, max, field) { if (v == null) return ''; const t = String(v).trim(); if (t.length > max) throw httpError(400, `${field} is too long.`); return t; }

function makeApp() {
  const rows = [];
  const pool = {
    query: async (sql, params = []) => {
      if (/^SELECT id FROM contacts/.test(sql.trim())) {
        const [phone, email] = params;
        return { rowCount: rows.filter((r) => (phone && r.phone === phone) || (email && r.email === email)).length, rows: rows.filter((r) => (phone && r.phone === phone) || (email && r.email === email)) };
      }
      if (/^INSERT INTO contacts/.test(sql.trim())) { rows.push({ id: rows.length + 1, name: params[0], phone: params[1], email: params[2], interests: params[3] }); return { rowCount: 1 }; }
      if (/^UPDATE contacts/.test(sql.trim())) { const r = rows.find((x) => x.id === params[0]); r.name = params[1]; return { rowCount: 1 }; }
      return { rowCount: 0, rows: [] };
    },
  };
  const app = express();
  const admin = express.Router();
  contacts(app, admin, { pool, httpError, wrap, cleanText, parseId: Number, clientIp: () => '1.1.1.1' + Math.random() });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  return { app, rows };
}

async function post(app, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  } finally { server.close(); }
}

test('a visitor who agrees is saved with a normalised number', async () => {
  const { app, rows } = makeApp();
  const r = await post(app, { name: 'Tari', phone: '+263 77 123 4567', consent: true, interests: ['events', 'hack'] });
  assert.equal(r.status, 200);
  assert.equal(rows[0].phone, '0771234567');
  assert.deepEqual(rows[0].interests, ['events']);
});

test('no consent, no contact', async () => {
  const { app, rows } = makeApp();
  const r = await post(app, { name: 'Tari', phone: '0771234567' });
  assert.equal(r.status, 400);
  assert.equal(rows.length, 0);
});

test('a number or an email is required, and must be valid', async () => {
  const { app } = makeApp();
  assert.equal((await post(app, { name: 'Tari', consent: true })).status, 400);
  assert.equal((await post(app, { name: 'Tari', email: 'nope', consent: true })).status, 400);
});

test('signing up twice updates the same person', async () => {
  const { app, rows } = makeApp();
  await post(app, { name: 'Tari', phone: '0771234567', consent: true });
  await post(app, { name: 'Tarisai', phone: '0771234567', consent: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Tarisai');
});

test('bots that fill the hidden field are ignored quietly', async () => {
  const { app, rows } = makeApp();
  const r = await post(app, { name: 'Bot', phone: '0771234567', consent: true, website: 'http://spam' });
  assert.equal(r.status, 200);
  assert.equal(rows.length, 0);
});

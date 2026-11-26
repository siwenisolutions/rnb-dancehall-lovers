'use strict';

// Visitor contacts.
//
// Visitors share their name and WhatsApp number or email through the
// "Get event updates" prompt on the website, and tick a consent box (the Cyber
// and Data Protection Act asks for consent before you message people). People
// who order from the shop also appear, marked "Shop order". The admin panel
// lists everyone, can export a CSV for WhatsApp/email tools, and can delete a
// contact when someone asks to be removed.

const express = require('express');

const CONSENT_TEXT = 'I agree to receive event news and offers from RnB Dancehall Lovers by WhatsApp or email. I can ask to stop at any time.';
const INTERESTS = ['events', 'tickets', 'merch', 'photos'];

module.exports = function contacts(app, admin, d) {
  const { pool, httpError, wrap, cleanText } = d;

  const recent = new Map(); // ip -> [times]
  function limited(ip) {
    const now = Date.now();
    const list = (recent.get(ip) || []).filter((t) => now - t < 3600000);
    list.push(now);
    recent.set(ip, list);
    if (recent.size > 5000) recent.clear();
    return list.length > 8;
  }

  function cleanPhone(v) {
    let p = String(v || '').replace(/[\s()-]/g, '');
    if (!p) return '';
    if (/^\+?263/.test(p)) p = '0' + p.replace(/^\+?263/, '');
    if (/^07\d{8}$/.test(p)) return p;
    if (/^\+\d{8,15}$/.test(p)) return p; // international numbers are fine too
    throw httpError(400, 'Please type a valid WhatsApp number, e.g. 0771 234 567.');
  }
  function cleanEmail(v) {
    const e = String(v || '').trim().toLowerCase();
    if (!e) return '';
    if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'Please type a valid email address.');
    return e;
  }

  app.post('/api/contacts', express.json({ limit: '4kb' }), wrap(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot field: bots fill it, people never see it
    if (limited(d.clientIp(req))) throw httpError(429, 'Thanks! You have already signed up from this device.');
    const name = cleanText(b.name, 80, 'Name');
    if (!name) throw httpError(400, 'Please add your name.');
    const phone = cleanPhone(b.phone);
    const email = cleanEmail(b.email);
    if (!phone && !email) throw httpError(400, 'Add a WhatsApp number or an email so we can reach you.');
    if (b.consent !== true) throw httpError(400, 'Please tick the box to agree to receive updates.');
    const interests = (Array.isArray(b.interests) ? b.interests : []).filter((i) => INTERESTS.includes(i));
    const page = String(b.page || '').slice(0, 200);
    // One row per person: matching phone or email updates the existing contact.
    const found = await pool.query(
      `SELECT id FROM contacts WHERE (phone <> '' AND phone = $1) OR (email <> '' AND email = $2) LIMIT 1`, [phone, email]);
    if (found.rowCount) {
      await pool.query(
        `UPDATE contacts SET name = $2, phone = COALESCE(NULLIF($3, ''), phone), email = COALESCE(NULLIF($4, ''), email),
           interests = $5, consent = true, consent_text = $6, consent_at = now(), page = $7, updated_at = now(), seen = false
         WHERE id = $1`, [found.rows[0].id, name, phone, email, interests, CONSENT_TEXT, page]);
    } else {
      await pool.query(
        `INSERT INTO contacts (name, phone, email, source, interests, consent, consent_text, consent_at, page)
         VALUES ($1, $2, $3, 'signup', $4, true, $5, now(), $6)`, [name, phone, email, interests, CONSENT_TEXT, page]);
    }
    res.json({ ok: true });
  }));

  app.get('/api/contacts/consent', (req, res) => res.json({ text: CONSENT_TEXT, interests: INTERESTS }));

  // Signups and shop customers together. Shop customers are listed once per phone.
  async function everyone() {
    const { rows } = await pool.query(
      `SELECT 'c' || id AS key, id, name, phone, email, source, interests, consent, consent_at, page, seen, created_at, updated_at
         FROM contacts
       UNION ALL
       SELECT * FROM (
         SELECT DISTINCT ON (o.phone) 'o' || o.id AS key, NULL::int AS id, o.name, o.phone, o.email, 'order' AS source,
                ARRAY[]::text[] AS interests, false AS consent, NULL::timestamptz AS consent_at, '' AS page, true AS seen,
                o.created_at, o.created_at AS updated_at
           FROM orders o
          WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.phone <> '' AND c.phone = o.phone)
          ORDER BY o.phone, o.created_at DESC
       ) shop_customers`);
    return rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  admin.get('/contacts', wrap(async (req, res) => {
    const list = await everyone();
    res.json({ contacts: list, unseen: list.filter((c) => c.source === 'signup' && !c.seen).length });
  }));

  admin.post('/contacts/seen', wrap(async (req, res) => {
    await pool.query('UPDATE contacts SET seen = true WHERE NOT seen');
    res.json({ ok: true });
  }));

  admin.get('/contacts.csv', wrap(async (req, res) => {
    const list = await everyone();
    const esc = (s) => { const v = String(s ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    const lines = ['Name,WhatsApp,Email,Source,Interests,Agreed to updates,Agreed on,Signed up'];
    for (const c of list) {
      lines.push([c.name, c.phone, c.email, c.source === 'order' ? 'Shop order' : 'Website signup', (c.interests || []).join('; '),
        c.consent ? 'Yes' : 'No', c.consent_at ? new Date(c.consent_at).toISOString().slice(0, 10) : '', new Date(c.created_at).toISOString().slice(0, 10)].map(esc).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="rnb-contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\n'));
  }));

  admin.delete('/contacts/:id', wrap(async (req, res) => {
    const id = d.parseId(req.params.id);
    const r = await pool.query('DELETE FROM contacts WHERE id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'That contact was already removed.');
    res.json({ ok: true });
  }));
};

module.exports.CONSENT_TEXT = CONSENT_TEXT;

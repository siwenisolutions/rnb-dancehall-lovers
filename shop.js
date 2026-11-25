'use strict';
// Merchandise shop: products (with photos and sizes), orders, and payment
// through Paynow (EcoCash, InnBucks). Delivery within 14 days.
//
// Payment:
// - With Paynow set up (Admin → Shop → Payments), the customer's phone gets
//   the EcoCash PIN prompt, or InnBucks gives a code to approve in
//   the InnBucks app. Paynow tells us when it's paid (resulturl), and the
//   order page also asks Paynow while the customer waits.
// - Without Paynow, the order is saved and the customer sees the shop's own
//   payment instructions (e.g. "Send to EcoCash 077…"); the admin marks the
//   order paid by hand.

const crypto = require('crypto');
const express = require('express');

const PAYNOW_INIT = process.env.PAYNOW_INIT_URL || 'https://www.paynow.co.zw/interface/remotetransaction';
const METHODS = { ecocash: 'EcoCash', innbucks: 'InnBucks' };
const STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'sent', 'delivered'];
const MAX_LINES = 10;
const MAX_QTY = 20;

module.exports = function shop(app, admin, d) {
  const { pool, insertMedia, forgetMediaFiles, processImage, assertRoomFor, httpError, wrap, cleanText, parseId, upload, siteUrl, clearPublicCache } = d;

  // ---------- settings ----------
  const SETTINGS = ['shop_paynow_id', 'shop_paynow_key', 'shop_paynow_email', 'shop_manual_pay', 'shop_methods', 'shop_open'];
  async function shopSettings() {
    const { rows } = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTINGS.map((k) => `_${k}`)]);
    const s = {};
    for (const r of rows) s[r.key.slice(1)] = r.value;
    const methods = (s.shop_methods || 'ecocash,innbucks').split(',').filter((m) => METHODS[m]);
    return {
      paynowId: s.shop_paynow_id || process.env.PAYNOW_INTEGRATION_ID || '',
      paynowKey: s.shop_paynow_key || process.env.PAYNOW_INTEGRATION_KEY || '',
      paynowEmail: s.shop_paynow_email || process.env.PAYNOW_AUTH_EMAIL || '',
      manual: s.shop_manual_pay || '',
      methods: methods.length ? methods : ['ecocash'],
      open: s.shop_open !== 'no',
    };
  }
  const paynowOn = (s) => !!(s.paynowId && s.paynowKey);

  // ---------- Paynow ----------
  function hash(values, key) {
    let str = '';
    for (const [k, v] of Object.entries(values)) if (k.toLowerCase() !== 'hash') str += v;
    return crypto.createHash('sha512').update(str + key, 'utf8').digest('hex').toUpperCase();
  }
  function parseReply(text) {
    const out = {};
    for (const pair of String(text || '').split('&')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
      out[k.toLowerCase()] = decodeURIComponent((i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' '));
    }
    return out;
  }
  function verify(values, key) {
    // Paynow's hash covers its fields in the order it sent them.
    return values.hash && values.hash.toUpperCase() === hash(values, key);
  }
  async function paynowPost(url, fields) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(30000),
    });
    return res.text();
  }
  // Paynow's statuses → ours.
  function mapStatus(s) {
    const v = String(s || '').toLowerCase();
    if (['paid', 'awaiting delivery', 'delivered'].includes(v)) return 'paid';
    if (['cancelled', 'failed', 'disputed', 'refunded'].includes(v)) return v === 'cancelled' ? 'cancelled' : 'failed';
    return 'pending';
  }

  async function startPayment(order, s) {
    const fields = {
      id: s.paynowId,
      reference: order.ref,
      amount: (order.total_cents / 100).toFixed(2),
      additionalinfo: 'RnB-Dancehall-Lovers-merch',
      returnurl: `${siteUrl()}/shop?order=${order.ref}`,
      resulturl: `${siteUrl()}/api/paynow/result`,
      authemail: s.paynowEmail || order.email,
      phone: order.pay_phone,
      method: order.pay_method,
      status: 'Message',
    };
    fields.hash = hash(fields, s.paynowKey);
    let reply;
    try {
      reply = parseReply(await paynowPost(PAYNOW_INIT, fields));
    } catch (err) {
      throw httpError(502, 'We couldn’t reach the payment service. Please try again in a minute.');
    }
    if (String(reply.status).toLowerCase() !== 'ok') {
      const msg = reply.error || 'The payment could not be started.';
      await pool.query("UPDATE orders SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [order.id, msg.slice(0, 300)]);
      throw httpError(400, `Payment could not start: ${msg}`);
    }
    if (!verify(reply, s.paynowKey)) throw httpError(502, 'The payment service sent an answer we couldn’t check. Please try again.');
    await pool.query(
      `UPDATE orders SET paynow_poll_url = $2, paynow_ref = $3, auth_code = $4, auth_expires = $5, updated_at = now() WHERE id = $1`,
      [order.id, reply.pollurl || null, reply.paynowreference || null, reply.authorizationcode || null, reply.authorizationexpires || null]);
  }

  async function setPaid(id, status, paynowRef) {
    await pool.query(
      `UPDATE orders SET status = $2, paynow_ref = COALESCE($3, paynow_ref), updated_at = now(),
              paid_at = CASE WHEN $2 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END, seen = CASE WHEN $2 = 'paid' THEN false ELSE seen END
        WHERE id = $1 AND (status = 'pending' OR (status = 'failed' AND $2 = 'paid'))`, [id, status, paynowRef || null]);
  }

  // Ask Paynow how a pending order is doing (at most every 4 seconds per order).
  const lastPoll = new Map();
  async function poll(order) {
    if (order.status !== 'pending' || !order.paynow_poll_url) return order;
    const now = Date.now();
    if (now - (lastPoll.get(order.id) || 0) < 4000) return order;
    lastPoll.set(order.id, now);
    const s = await shopSettings();
    if (!paynowOn(s)) return order;
    try {
      const reply = parseReply(await paynowPost(order.paynow_poll_url, {}));
      if (!verify(reply, s.paynowKey) || reply.reference !== order.ref) return order;
      const status = mapStatus(reply.status);
      if (status !== 'pending') {
        await setPaid(order.id, status, reply.paynowreference);
        return (await pool.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
      }
    } catch (err) {
      console.warn(`[shop] poll ${order.ref}: ${err.message}`);
    }
    return order;
  }

  // ---------- public ----------
  const productCols = `p.id, p.name, p.description, p.price_cents, p.sizes, p.active, p.sort,
    ARRAY(SELECT m.id FROM media m WHERE m.product_id = p.id ORDER BY m.created_at, m.id) AS photo_ids`;
  function sizesOf(p) { return String(p.sizes || '').split(/\n|,/).map((x) => x.trim()).filter(Boolean); }
  function publicProduct(p) {
    return { id: p.id, name: p.name, description: p.description, price_cents: p.price_cents, sizes: sizesOf(p), photo_ids: p.photo_ids };
  }

  app.get('/api/shop', wrap(async (req, res) => {
    const s = await shopSettings();
    const { rows } = await pool.query(`SELECT ${productCols} FROM products p WHERE p.active ORDER BY p.sort, p.id`);
    res.json({
      open: s.open,
      products: rows.map(publicProduct),
      methods: s.methods.map((m) => ({ id: m, name: METHODS[m] })),
      online: paynowOn(s),
    });
  }));

  const ordersBody = express.json({ limit: '20kb' });
  const recent = new Map(); // ip -> [times]
  function limitOrders(ip) {
    const now = Date.now();
    const list = (recent.get(ip) || []).filter((t) => now - t < 3600000);
    list.push(now);
    recent.set(ip, list);
    if (recent.size > 5000) recent.clear();
    return list.length > 15;
  }
  function cleanPhone(v, field) {
    let p = String(v || '').replace(/[\s()-]/g, '');
    if (/^\+?263/.test(p)) p = '0' + p.replace(/^\+?263/, '');
    if (!/^07\d{8}$/.test(p)) throw httpError(400, `${field}: please type a Zimbabwe mobile number, e.g. 0771 234 567.`);
    return p;
  }

  app.post('/api/orders', ordersBody, wrap(async (req, res) => {
    if (limitOrders(d.clientIp(req))) throw httpError(429, 'Too many orders from this phone. Please try again later.');
    const b = req.body || {};
    const s = await shopSettings();
    if (!s.open) throw httpError(400, 'The shop is closed at the moment.');
    const lines = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES + 1) : [];
    if (!lines.length) throw httpError(400, 'Your bag is empty.');
    if (lines.length > MAX_LINES) throw httpError(400, `Please order at most ${MAX_LINES} different items at a time.`);
    const ids = [...new Set(lines.map((l) => parseInt(l.product_id, 10)).filter((n) => n > 0))];
    const { rows } = await pool.query('SELECT id, name, price_cents, sizes FROM products WHERE active AND id = ANY($1::int[])', [ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = [];
    for (const l of lines) {
      const p = byId.get(parseInt(l.product_id, 10));
      if (!p) throw httpError(400, 'One of the items is no longer available. Please remove it from your bag.');
      if (!(p.price_cents > 0)) throw httpError(400, `${p.name} isn't on sale yet (price coming soon). Please remove it from your bag.`);
      const sizes = sizesOf(p);
      const size = String(l.size || '').trim();
      if (sizes.length && !sizes.includes(size)) throw httpError(400, `Choose a size for ${p.name}.`);
      const qty = parseInt(l.qty, 10);
      if (!(qty >= 1 && qty <= MAX_QTY)) throw httpError(400, `Quantity for ${p.name} must be between 1 and ${MAX_QTY}.`);
      items.push({ product_id: p.id, name: p.name, size: sizes.length ? size : '', qty, price_cents: p.price_cents });
    }
    const total = items.reduce((n, i) => n + i.price_cents * i.qty, 0);
    const name = cleanText(b.name, 120, 'Name');
    if (!name) throw httpError(400, 'Please type your name.');
    const phone = cleanPhone(b.phone, 'Phone');
    const email = cleanText(b.email, 200, 'Email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'That email address looks wrong.');
    const city = cleanText(b.city, 100, 'City');
    const address = cleanText(b.address, 500, 'Delivery address');
    if (!city || !address) throw httpError(400, 'Please type your city and delivery address.');
    const note = cleanText(b.note, 500, 'Note');
    const online = paynowOn(s);
    const method = String(b.method || '');
    if (online && !s.methods.includes(method)) throw httpError(400, 'Choose how you want to pay.');
    const payPhone = online && method !== 'innbucks' ? cleanPhone(b.pay_phone || phone, `${METHODS[method]} number`) : '';
    if (online && !email && !s.paynowEmail) throw httpError(400, 'Please type your email address for the payment receipt.');

    const ref = `RDL${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const ins = await pool.query(
      `INSERT INTO orders (ref, name, phone, email, city, address, note, items, total_cents, pay_method, pay_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [ref, name, phone, email, city, address, note, JSON.stringify(items), total, online ? method : 'manual', payPhone]);
    const order = ins.rows[0];
    if (online) await startPayment(order, s);
    res.status(201).json(await orderView(ref));
  }));

  async function orderView(ref) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE ref = $1', [ref]);
    if (!rows.length) throw httpError(404, 'Order not found.');
    const o = await poll(rows[0]);
    const s = await shopSettings();
    return {
      ref: o.ref, status: o.status, total_cents: o.total_cents, items: o.items, name: o.name,
      pay_method: o.pay_method, method_name: METHODS[o.pay_method] || '', pay_phone: o.pay_phone,
      auth_code: o.status === 'pending' ? o.auth_code : null, auth_expires: o.status === 'pending' ? o.auth_expires : null,
      manual: o.pay_method === 'manual' ? s.manual : '', error: o.status === 'failed' ? o.error : null,
      created_at: o.created_at,
    };
  }

  // The order reference has 8 random characters, so it can't be guessed.
  app.get('/api/orders/:ref', wrap(async (req, res) => {
    const ref = String(req.params.ref || '');
    if (!/^RDL[0-9A-F]{8}$/.test(ref)) throw httpError(404, 'Order not found.');
    res.set('Cache-Control', 'no-store');
    res.json(await orderView(ref));
  }));

  // Paynow's status update for an order.
  app.post('/api/paynow/result', express.text({ type: '*/*', limit: '10kb' }), wrap(async (req, res) => {
    const s = await shopSettings();
    const reply = parseReply(req.body);
    res.type('text').send('ok');
    if (!paynowOn(s) || !verify(reply, s.paynowKey)) return console.warn('[shop] Paynow update with a wrong hash ignored');
    const { rows } = await pool.query('SELECT id, total_cents FROM orders WHERE ref = $1', [reply.reference]);
    if (!rows.length) return;
    const status = mapStatus(reply.status);
    if (status === 'paid' && Math.round(parseFloat(reply.amount) * 100) < rows[0].total_cents) {
      return console.warn(`[shop] ${reply.reference}: paid amount ${reply.amount} is less than the order total`);
    }
    if (status !== 'pending') await setPaid(rows[0].id, status, reply.paynowreference);
  }));

  // ---------- admin: products ----------
  function productFromBody(b) {
    const name = cleanText(b.name, 120, 'Name');
    if (!name) throw httpError(400, 'Give the item a name.');
    // Empty price = "Price coming soon": the item shows in the shop but can't be ordered yet.
    const rawPrice = String(b.price == null ? '' : b.price).trim();
    let price = null;
    if (rawPrice) {
      price = Math.round(parseFloat(rawPrice.replace(/[^0-9.]/g, '')) * 100);
      if (!(price > 0)) throw httpError(400, 'Type a price, e.g. 25 or 12.50 — or leave it empty for "Price coming soon".');
      if (price >= 100000000) throw httpError(400, 'That price is too high.');
    }
    const sizes = String(b.sizes || '').split(/\n|,/).map((x) => x.trim().slice(0, 20)).filter(Boolean).slice(0, 15).join('\n');
    return { name, description: cleanText(b.description, 2000, 'Description'), price, sizes, active: b.active !== false && b.active !== 'false' };
  }
  admin.get('/shop', wrap(async (req, res) => {
    const s = await shopSettings();
    const p = await pool.query(`SELECT ${productCols} FROM products p ORDER BY p.sort, p.id`);
    res.json({
      products: p.rows.map((r) => ({ ...publicProduct(r), active: r.active, sizes_text: r.sizes })),
      settings: {
        paynow_id: s.paynowId, paynow_key_set: !!s.paynowKey, paynow_email: s.paynowEmail,
        manual: s.manual, methods: s.methods, open: s.open, online: paynowOn(s),
        result_url: `${siteUrl()}/api/paynow/result`,
      },
    });
  }));
  admin.post('/shop/products', wrap(async (req, res) => {
    const p = productFromBody(req.body || {});
    const { rows } = await pool.query(
      `INSERT INTO products (name, description, price_cents, sizes, active, sort)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(sort), 0) + 1 FROM products)) RETURNING id`,
      [p.name, p.description, p.price, p.sizes, p.active]);
    res.status(201).json({ id: rows[0].id });
  }));
  admin.put('/shop/products/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const p = productFromBody(req.body || {});
    const r = await pool.query('UPDATE products SET name = $1, description = $2, price_cents = $3, sizes = $4, active = $5 WHERE id = $6',
      [p.name, p.description, p.price, p.sizes, p.active, id]);
    if (!r.rowCount) throw httpError(404, 'Item not found.');
    res.json({ ok: true });
  }));
  admin.delete('/shop/products/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const photos = await pool.query('SELECT id FROM media WHERE product_id = $1', [id]);
    const r = await pool.query('DELETE FROM products WHERE id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'Item not found.');
    photos.rows.forEach((m) => forgetMediaFiles(m.id));
    res.json({ ok: true });
  }));
  admin.post('/shop/products/:id/photos', upload.array('photos', 10), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const files = req.files || [];
    if (!files.length) throw httpError(400, 'Choose at least one photo.');
    const ok = await pool.query('SELECT 1 FROM products WHERE id = $1', [id]);
    if (!ok.rowCount) throw httpError(400, 'That item no longer exists.');
    await assertRoomFor(files.reduce((n, f) => n + f.size, 0));
    const ids = [];
    for (const f of files) {
      const img = await processImage(f.buffer, f.thumb && f.thumb.buffer);
      if (!img.mime.startsWith('image/')) throw httpError(400, 'Shop items take photos only.');
      ids.push(await insertMedia({ category: 'product', caption: '', eventId: null, img, productId: id }));
    }
    res.status(201).json({ ids });
  }));
  admin.delete('/shop/products/:id/photos/:mid', wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM media WHERE id = $1 AND product_id = $2 RETURNING id', [parseId(req.params.mid), parseId(req.params.id)]);
    if (!r.rowCount) throw httpError(404, 'Photo not found.');
    forgetMediaFiles(r.rows[0].id);
    res.json({ ok: true });
  }));

  // ---------- admin: payment settings ----------
  admin.put('/shop/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const set = async (k, v) => pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [`_${k}`, v]);
    if ('paynow_id' in b) {
      const v = cleanText(b.paynow_id, 20, 'Integration ID');
      if (v && !/^\d+$/.test(v)) throw httpError(400, 'The Paynow integration ID is a number, e.g. 12345.');
      await set('shop_paynow_id', v);
    }
    // The key is never sent back to the browser; an empty box keeps the saved one.
    if (b.paynow_key) {
      const v = cleanText(b.paynow_key, 100, 'Integration key');
      if (!/^[0-9a-f-]{20,60}$/i.test(v)) throw httpError(400, 'That doesn’t look like a Paynow integration key. Copy it again from Paynow.');
      await set('shop_paynow_key', v);
    }
    if (b.clear_paynow === true) { await set('shop_paynow_id', ''); await set('shop_paynow_key', ''); }
    if ('paynow_email' in b) {
      const v = cleanText(b.paynow_email, 200, 'Paynow email');
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw httpError(400, 'The Paynow email looks wrong.');
      await set('shop_paynow_email', v);
    }
    if ('manual' in b) await set('shop_manual_pay', cleanText(b.manual, 1000, 'Payment instructions'));
    if (Array.isArray(b.methods)) {
      const m = b.methods.filter((x) => METHODS[x]);
      if (!m.length) throw httpError(400, 'Choose at least one way to pay.');
      await set('shop_methods', m.join(','));
    }
    if ('open' in b) await set('shop_open', b.open ? 'yes' : 'no');
    clearPublicCache();
    res.json({ ok: true });
  }));

  // ---------- admin: orders ----------
  admin.get('/shop/orders', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, ref, name, phone, email, city, address, note, items, total_cents, pay_method, pay_phone, status, paynow_ref,
              error, seen, created_at, paid_at, updated_at
         FROM orders ORDER BY created_at DESC LIMIT 300`);
    res.json({ orders: rows, methods: METHODS });
  }));
  admin.put('/shop/orders/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const status = String((req.body || {}).status || '');
    if (!STATUSES.includes(status)) throw httpError(400, 'Unknown order status.');
    const r = await pool.query(
      `UPDATE orders SET status = $2, updated_at = now(), seen = true,
              paid_at = CASE WHEN $2 IN ('paid', 'sent', 'delivered') AND paid_at IS NULL THEN now() ELSE paid_at END
        WHERE id = $1`, [id, status]);
    if (!r.rowCount) throw httpError(404, 'Order not found.');
    res.json({ ok: true });
  }));
  admin.post('/shop/orders/seen', wrap(async (req, res) => {
    await pool.query('UPDATE orders SET seen = true WHERE NOT seen');
    res.json({ ok: true });
  }));
  return { shopSettings };
};

// Pending orders older than a day were never paid (run by the scheduled job).
module.exports.cancelStaleOrders = (pool) => pool.query(
  "UPDATE orders SET status = 'cancelled', error = 'Not paid within a day', updated_at = now() WHERE status = 'pending' AND created_at < now() - interval '1 day' AND pay_method <> 'manual'");

module.exports.hashForTest = (values, key) => {
  let str = '';
  for (const [k, v] of Object.entries(values)) if (k.toLowerCase() !== 'hash') str += v;
  return crypto.createHash('sha512').update(str + key, 'utf8').digest('hex').toUpperCase();
};

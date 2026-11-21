/* Merch shop: items, bag, checkout and payment status (see shop.js on the server). */
(function () {
  'use strict';
  var R = window.RNB, el = R.el, t = R.t;
  var grid = document.getElementById('shopGrid');
  var sheet = document.getElementById('sheet'), body = document.getElementById('sheetBody');
  var fab = document.getElementById('bagFab'), fabText = document.getElementById('bagFabText');
  var shop = { products: [], methods: [], online: false, open: true };
  var bag = [];
  var pollTimer = null;

  function money(c) { var v = c / 100; return '$' + (v % 1 ? v.toFixed(2) : String(v)); }
  function photo(id, thumb) { return R.mediaUrl(id, thumb); }
  function tx(key, fallback) { return t(key) || fallback; }

  // ---------- bag (kept on this phone) ----------
  try { bag = JSON.parse(localStorage.getItem('rnbBag') || '[]') || []; } catch (e) { bag = []; }
  function saveBag() { try { localStorage.setItem('rnbBag', JSON.stringify(bag)); } catch (e) { /* private mode */ } updateFab(); }
  function product(id) { return shop.products.filter(function (p) { return p.id === id; })[0]; }
  function bagLines() { return bag.filter(function (l) { return product(l.product_id); }); }
  function bagTotal() { return bagLines().reduce(function (n, l) { return n + product(l.product_id).price_cents * l.qty; }, 0); }
  function bagCount() { return bagLines().reduce(function (n, l) { return n + l.qty; }, 0); }
  function updateFab() {
    var n = bagCount();
    fab.hidden = n === 0;
    fabText.textContent = tx('shop_bag', 'Your bag') + ' · ' + n + ' · ' + money(bagTotal());
  }
  fab.addEventListener('click', showBag);

  // ---------- sheet ----------
  function open(nodes, title) {
    body.textContent = '';
    if (title) body.appendChild(el('h2', { class: 'shop-h', id: 'sheetTitle', text: title }));
    nodes.forEach(function (n) { if (n) body.appendChild(n); });
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    body.parentNode.scrollTop = 0;
  }
  function close() {
    sheet.hidden = true;
    document.body.style.overflow = '';
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
  sheet.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', close); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sheet.hidden) close(); });

  function photoStrip(p) {
    var ids = p.photo_ids.length ? p.photo_ids : [null];
    var strip = el('div', { class: 'shop-photos' }, ids.map(function (id) {
      return id ? el('div', { class: 'shop-photo', style: "background-image:url('" + photo(id) + "')", role: 'img', 'aria-label': p.name })
        : el('div', { class: 'shop-photo empty' }, [el('span', { text: p.name })]);
    }));
    if (ids.length < 2) return strip;
    var dots = el('div', { class: 'flyer-dots' }, ids.map(function (x, i) { return el('span', { class: i ? '' : 'on' }); }));
    strip.addEventListener('scroll', function () {
      var i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
      [].forEach.call(dots.children, function (d, j) { d.className = j === i ? 'on' : ''; });
    }, { passive: true });
    return el('div', { class: 'flyers many' }, [strip, dots]);
  }

  // ---------- items ----------
  function render() {
    grid.textContent = '';
    if (!shop.open || !shop.products.length) {
      grid.appendChild(el('div', { class: 'empty-state' }, [el('b', { text: tx('shop_empty', 'New merch is on the way.') })]));
      return;
    }
    shop.products.forEach(function (p) {
      var card = el('button', { class: 'shop-card', type: 'button', 'aria-label': p.name + ', ' + money(p.price_cents) }, [
        p.photo_ids.length ? el('div', { class: 'shop-card-img', style: "background-image:url('" + photo(p.photo_ids[0], true) + "')" })
          : el('div', { class: 'shop-card-img empty' }, [el('span', { text: p.name })]),
        el('div', { class: 'shop-card-body' }, [
          el('b', { text: p.name }),
          el('span', { class: 'price', text: money(p.price_cents) }),
          p.sizes.length ? el('small', { text: p.sizes.join(' · ') }) : null
        ])
      ]);
      card.addEventListener('click', function () { showItem(p); });
      grid.appendChild(card);
    });
  }

  function showItem(p) {
    var size = p.sizes.length === 1 ? p.sizes[0] : '', qty = 1;
    var msg = el('p', { class: 'shop-msg', hidden: true });
    var sizeBox = null;
    if (p.sizes.length) {
      sizeBox = el('div', { class: 'shop-sizes', role: 'radiogroup', 'aria-label': 'Size' }, p.sizes.map(function (s) {
        var b = el('button', { type: 'button', role: 'radio', 'aria-checked': s === size ? 'true' : 'false', text: s });
        b.addEventListener('click', function () {
          size = s;
          sizeBox.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
          msg.hidden = true;
        });
        return b;
      }));
    }
    var qtyText = el('span', { class: 'qty-n', text: '1' });
    function setQty(n) { qty = Math.max(1, Math.min(20, n)); qtyText.textContent = String(qty); }
    var add = el('button', { class: 'btn btn-primary btn-block', type: 'button', text: tx('shop_add', 'Add to bag') + ' · ' + money(p.price_cents) });
    add.addEventListener('click', function () {
      if (p.sizes.length && !size) { msg.textContent = 'Choose your size first.'; msg.hidden = false; return; }
      var same = bag.filter(function (l) { return l.product_id === p.id && l.size === size; })[0];
      if (same) same.qty = Math.min(20, same.qty + qty);
      else bag.push({ product_id: p.id, size: size, qty: qty });
      saveBag();
      showBag(p.name + (size ? ' (' + size + ')' : '') + ' added.');
    });
    open([
      photoStrip(p),
      el('div', { class: 'shop-item-head' }, [el('h2', { class: 'shop-h', id: 'sheetTitle', text: p.name }), el('span', { class: 'price', text: money(p.price_cents) })]),
      p.description ? el('p', { class: 'shop-desc', text: p.description }) : null,
      sizeBox ? el('p', { class: 'shop-label', text: 'Size' }) : null,
      sizeBox,
      el('p', { class: 'shop-label', text: 'Quantity' }),
      el('div', { class: 'shop-qty' }, [
        el('button', { type: 'button', 'aria-label': 'One less', text: '−', onclick: function () { setQty(qty - 1); } }),
        qtyText,
        el('button', { type: 'button', 'aria-label': 'One more', text: '+', onclick: function () { setQty(qty + 1); } })
      ]),
      msg,
      add,
      el('p', { class: 'shop-note', text: '🚚 ' + tx('shop_delivery', 'Delivery within 14 days') })
    ]);
  }

  // ---------- bag ----------
  function showBag(note) {
    var lines = bagLines();
    if (!lines.length) {
      open([el('p', { class: 'shop-desc', text: 'Your bag is empty.' }),
        el('button', { class: 'btn btn-outline btn-block', type: 'button', text: 'Keep shopping', onclick: close })], tx('shop_bag', 'Your bag'));
      return;
    }
    var list = el('div', { class: 'bag-lines' });
    lines.forEach(function (l) {
      var p = product(l.product_id);
      var n = el('span', { class: 'qty-n', text: String(l.qty) });
      list.appendChild(el('div', { class: 'bag-line' }, [
        el('span', { class: 'bag-img', style: p.photo_ids.length ? "background-image:url('" + photo(p.photo_ids[0], true) + "')" : '' }),
        el('div', { class: 'bag-txt' }, [
          el('b', { text: p.name }),
          el('small', { text: (l.size ? 'Size ' + l.size + ' · ' : '') + money(p.price_cents) + ' each' }),
          el('div', { class: 'shop-qty small' }, [
            el('button', { type: 'button', 'aria-label': 'One less', text: '−', onclick: function () {
              l.qty -= 1;
              if (l.qty < 1) bag.splice(bag.indexOf(l), 1);
              saveBag(); showBag();
            } }),
            n,
            el('button', { type: 'button', 'aria-label': 'One more', text: '+', onclick: function () { l.qty = Math.min(20, l.qty + 1); saveBag(); showBag(); } })
          ])
        ]),
        el('b', { class: 'bag-sum', text: money(p.price_cents * l.qty) })
      ]));
    });
    open([
      note ? el('p', { class: 'shop-ok', text: '✓ ' + note }) : null,
      list,
      el('div', { class: 'bag-total' }, [el('span', { text: 'Total' }), el('b', { text: money(bagTotal()) })]),
      el('p', { class: 'shop-note', text: '🚚 ' + tx('shop_delivery', 'Delivery within 14 days') }),
      el('button', { class: 'btn btn-primary btn-block', type: 'button', text: tx('shop_checkout', 'Checkout'), onclick: showCheckout }),
      el('button', { class: 'btn btn-outline btn-block', type: 'button', text: 'Keep shopping', onclick: close })
    ], tx('shop_bag', 'Your bag'));
  }

  // ---------- checkout ----------
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('rnbBuyer') || '{}') || {}; } catch (e) { saved = {}; }
  function field(label, name, attrs) {
    var input = el(attrs && attrs.rows ? 'textarea' : 'input', Object.assign({ name: name, id: 'co_' + name }, attrs || {}));
    if (saved[name]) input.value = saved[name];
    return el('div', { class: 'co-field' }, [el('label', { for: 'co_' + name, text: label }), input]);
  }
  function showCheckout() {
    var form = el('form', { class: 'co-form', novalidate: true });
    form.appendChild(field('Full name', 'name', { autocomplete: 'name', required: true, maxlength: '120' }));
    form.appendChild(field('Phone number', 'phone', { type: 'tel', autocomplete: 'tel', required: true, placeholder: '0771 234 567' }));
    form.appendChild(field(shop.online ? 'Email (for your receipt)' : 'Email (optional)', 'email', { type: 'email', autocomplete: 'email', maxlength: '200' }));
    form.appendChild(field('City / town', 'city', { autocomplete: 'address-level2', required: true, maxlength: '100' }));
    form.appendChild(field('Delivery address', 'address', { autocomplete: 'street-address', required: true, rows: '2', maxlength: '500' }));
    form.appendChild(field('Note (optional)', 'note', { maxlength: '500', placeholder: 'e.g. call before delivering' }));
    var method = shop.methods[0] ? shop.methods[0].id : '';
    var payPhone = null;
    if (shop.online) {
      form.appendChild(el('p', { class: 'shop-label', text: 'Pay with' }));
      var opts = el('div', { class: 'pay-opts', role: 'radiogroup' });
      shop.methods.forEach(function (m) {
        var b = el('button', { type: 'button', role: 'radio', class: 'pay-opt pay-' + m.id, 'aria-checked': m.id === method ? 'true' : 'false', text: m.name });
        b.addEventListener('click', function () {
          method = m.id;
          opts.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
          payPhone.hidden = method === 'innbucks';
        });
        opts.appendChild(b);
      });
      form.appendChild(opts);
      payPhone = field('Number to pay from', 'pay_phone', { type: 'tel', placeholder: 'Same as your phone number' });
      payPhone.appendChild(el('small', { class: 'co-hint', text: 'You’ll get a prompt on this phone to enter your PIN.' }));
      payPhone.hidden = method === 'innbucks';
      form.appendChild(payPhone);
    }
    var msg = el('p', { class: 'shop-msg', hidden: true });
    var btn = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: (shop.online ? tx('shop_pay', 'Pay') + ' ' : 'Place order · ') + money(bagTotal()) });
    form.appendChild(msg);
    form.appendChild(btn);
    form.appendChild(el('p', { class: 'shop-note', text: '🚚 ' + tx('shop_delivery', 'Delivery within 14 days') }));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      ['name', 'phone', 'email', 'city', 'address', 'note', 'pay_phone'].forEach(function (k) { if (form.elements[k]) data[k] = form.elements[k].value.trim(); });
      try { localStorage.setItem('rnbBuyer', JSON.stringify({ name: data.name, phone: data.phone, email: data.email, city: data.city, address: data.address })); } catch (err) { /* ignore */ }
      data.method = method;
      data.items = bagLines();
      btn.disabled = true;
      btn.textContent = shop.online ? 'Starting payment…' : 'Sending…';
      msg.hidden = true;
      fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); })
        .then(function (o) {
          try { history.replaceState(null, '', '/shop?order=' + o.ref); } catch (err) { /* ignore */ }
          showOrder(o);
        })
        .catch(function (err) {
          msg.textContent = err.message; msg.hidden = false;
          btn.disabled = false;
          btn.textContent = (shop.online ? tx('shop_pay', 'Pay') + ' ' : 'Place order · ') + money(bagTotal());
        });
    });
    open([form], tx('shop_checkout', 'Checkout'));
  }

  // ---------- order status ----------
  function summary(o) {
    return el('div', { class: 'bag-lines' }, o.items.map(function (i) {
      return el('div', { class: 'order-line' }, [el('span', { text: i.qty + ' × ' + i.name + (i.size ? ' (' + i.size + ')' : '') }), el('b', { text: money(i.price_cents * i.qty) })]);
    }).concat([el('div', { class: 'bag-total' }, [el('span', { text: 'Total' }), el('b', { text: money(o.total_cents) })])]));
  }
  function showOrder(o, tries) {
    tries = tries || 0;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    var ref = el('p', { class: 'order-ref', text: 'Order ' + o.ref });
    var nodes;
    if (o.status === 'paid' || o.status === 'sent' || o.status === 'delivered') {
      bag = []; saveBag();
      nodes = [el('div', { class: 'order-big ok', text: '✓' }), el('p', { class: 'shop-desc', text: tx('shop_thanks', 'Thank you! Your order is paid. We’ll deliver within 14 days.') }), ref, summary(o),
        el('button', { class: 'btn btn-outline btn-block', type: 'button', text: 'Back to the shop', onclick: function () { close(); history.replaceState(null, '', '/shop'); } })];
      open(nodes, 'Payment received');
      return;
    }
    if (o.status === 'failed' || o.status === 'cancelled') {
      nodes = [el('div', { class: 'order-big bad', text: '!' }),
        el('p', { class: 'shop-desc', text: (o.error ? o.error + '. ' : '') + 'The payment didn’t go through, so nothing was taken. Your bag is still saved.' }), ref,
        el('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Try again', onclick: showCheckout })];
      open(nodes, 'Payment not completed');
      return;
    }
    if (o.pay_method === 'manual') {
      bag = []; saveBag();
      nodes = [el('div', { class: 'order-big ok', text: '✓' }), el('p', { class: 'shop-desc', text: 'Your order is in. To finish, pay ' + money(o.total_cents) + ' as shown below and use ' + o.ref + ' as the reference.' }),
        o.manual ? el('div', { class: 'order-manual', text: o.manual }) : null, ref, summary(o),
        el('p', { class: 'shop-note', text: '🚚 ' + tx('shop_delivery', 'Delivery within 14 days') + ' after payment.' })];
      open(nodes, 'Order received');
      return;
    }
    // Waiting for the customer to approve the payment.
    if (o.pay_method === 'innbucks' && o.auth_code) {
      var code = o.auth_code;
      nodes = [el('p', { class: 'shop-desc', text: 'Open InnBucks and approve the payment of ' + money(o.total_cents) + ' with this code:' }),
        el('div', { class: 'order-code', text: code }),
        o.auth_expires ? el('p', { class: 'shop-note', text: 'Use it before ' + o.auth_expires + '.' }) : null,
        el('a', { class: 'btn btn-primary btn-block', href: 'com.innbucks.customer://purchase?paymentToken=' + encodeURIComponent(code), text: 'Open InnBucks' }),
        el('button', { class: 'btn btn-outline btn-block', type: 'button', text: 'Copy the code', onclick: function (e) {
          var b = e.currentTarget;
          if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { b.textContent = 'Copied'; });
        } })];
    } else {
      nodes = [el('div', { class: 'order-spin', 'aria-hidden': 'true' }),
        el('p', { class: 'shop-desc', text: 'Check your phone' + (o.pay_phone ? ' (' + o.pay_phone + ')' : '') + ': enter your ' + (o.method_name || 'mobile money') + ' PIN to pay ' + money(o.total_cents) + '.' }),
        el('p', { class: 'shop-note', text: 'No prompt after a minute? Check the number and your balance, then try again.' }),
        el('button', { class: 'btn btn-outline btn-block', type: 'button', text: 'Change number or payment method', onclick: showCheckout })];
    }
    nodes.push(el('p', { class: 'shop-note wait', text: 'This page updates by itself once you’ve paid.' }), ref, summary(o));
    open(nodes, 'Approve the payment');
    // Check every 5 seconds for 10 minutes.
    if (tries < 120) {
      pollTimer = setTimeout(function () {
        R.api('/api/orders/' + o.ref).then(function (n) { showOrder(n, tries + 1); }, function () { showOrder(o, tries + 1); });
      }, 5000);
    }
  }

  // ---------- start ----------
  R.api('/api/shop').then(function (d) {
    shop = d;
    render();
    updateFab();
    var ref = new URLSearchParams(location.search).get('order');
    if (ref && /^RDL[0-9A-F]{8}$/.test(ref)) R.api('/api/orders/' + ref).then(function (o) { showOrder(o); }).catch(function () { /* unknown order */ });
    var item = new URLSearchParams(location.search).get('item');
    if (item) { var p = product(parseInt(item, 10)); if (p) showItem(p); }
  }).catch(function () {
    grid.textContent = '';
    grid.appendChild(el('p', { class: 'status-msg', text: 'The shop couldn’t load. Please refresh the page.' }));
  });
})();

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

  // Line icons (fixed markup, never from the admin panel).
  var ICONS = {
    truck: '<path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3.5V16h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 7v6"/><path d="M12 16.5v.5"/>'
  };
  function icon(name) {
    var s = document.createElement('span');
    s.className = 'ic ic-' + name;
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 24 24">' + ICONS[name] + '</svg>';
    return s;
  }
  function deliveryNote(extra) {
    return el('p', { class: 'shop-note' }, [icon('truck'), tx('shop_delivery', 'Delivery within 14 days') + (extra || '')]);
  }
  function money(c) { var v = c / 100; return '$' + (v % 1 ? v.toFixed(2) : String(v)); }
  function priced(p) { return p.price_cents > 0; }
  function priceText(p) { return priced(p) ? money(p.price_cents) : tx('shop_soon', 'Price coming soon'); }
  // WhatsApp chat with the business number (from the site settings), for items without a price yet.
  var contactPhone = '077 167 4200';
  R.api('/api/settings').then(function (s) { if (s && s.phone) contactPhone = s.phone; }).catch(function () {});
  function enquireUrl(p) {
    var digits = String(contactPhone).replace(/\D/g, '').replace(/^0/, '263');
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent("Hi! I'm interested in the " + p.name + ' from your merch shop. When will it be available, and how much is it?');
  }
  function photo(id, thumb) { return R.mediaUrl(id, thumb); }
  function tx(key, fallback) { return t(key) || fallback; }

  // ---------- bag (kept on this phone) ----------
  try { bag = JSON.parse(localStorage.getItem('rnbBag') || '[]') || []; } catch (e) { bag = []; }
  function saveBag() { try { localStorage.setItem('rnbBag', JSON.stringify(bag)); } catch (e) { /* private mode */ } updateFab(); }
  function product(id) { return shop.products.filter(function (p) { return p.id === id; })[0]; }
  function bagLines() { return bag.filter(function (l) { var p = product(l.product_id); return p && priced(p); }); }
  function bagTotal() { return bagLines().reduce(function (n, l) { return n + product(l.product_id).price_cents * l.qty; }, 0); }
  function bagCount() { return bagLines().reduce(function (n, l) { return n + l.qty; }, 0); }
  function updateFab() {
    var n = bagCount();
    fab.hidden = n === 0;
    fabText.textContent = tx('shop_bag', 'Your bag') + ' · ' + n + ' · ' + money(bagTotal());
    var pill = document.getElementById('bagPillText');
    if (pill) pill.textContent = tx('shop_bag', 'Your bag') + ' · ' + n + (n ? ' · ' + money(bagTotal()) : '');
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

  // ---------- items: categories, filters, sort ----------
  var CAT_NAMES = { clothing: 'Clothing', headwear: 'Caps & hats', accessories: 'Accessories', drinkware: 'Cups & bottles' };
  var SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL'];
  var PRICE_BANDS = [
    { id: 'u10', label: 'Under $10', test: function (c) { return c > 0 && c < 1000; } },
    { id: '10-25', label: '$10 – $25', test: function (c) { return c >= 1000 && c < 2500; } },
    { id: '25-50', label: '$25 – $50', test: function (c) { return c >= 2500 && c < 5000; } },
    { id: '50+', label: '$50 and up', test: function (c) { return c >= 5000; } },
    { id: 'soon', label: 'Price coming soon', test: function (c) { return !(c > 0); } }
  ];
  var state = { cat: '', sizes: [], price: '', stock: false, sort: 'featured' };
  try { var qc = new URLSearchParams(location.search).get('cat'); if (qc && CAT_NAMES[qc]) state.cat = qc; } catch (e) { /* old browser */ }
  var catsBox = document.getElementById('shopCats');
  var filtersBox = document.getElementById('shopFilters');
  var countEl = document.getElementById('shopCount');
  var sortSel = document.getElementById('shopSort');
  var filterToggle = document.getElementById('filterToggle');
  var newestId = null;

  function band(id) { return PRICE_BANDS.filter(function (b) { return b.id === id; })[0]; }
  function matches(p, skip) {
    if (skip !== 'cat' && state.cat && p.category !== state.cat) return false;
    if (skip !== 'size' && state.sizes.length && !(p.sizes.length ? p.sizes.some(function (z) { return state.sizes.indexOf(z) !== -1; }) : state.sizes.indexOf('One size') !== -1)) return false;
    if (skip !== 'price' && state.price && !band(state.price).test(p.price_cents)) return false;
    if (skip !== 'stock' && state.stock && p.in_stock === false) return false;
    return true;
  }
  function sorted(list) {
    var l = list.slice();
    var price = function (p) { return p.price_cents > 0 ? p.price_cents : null; };
    if (state.sort === 'new') l.sort(function (a, b) { return b.id - a.id; });
    if (state.sort === 'low' || state.sort === 'high') {
      l.sort(function (a, b) {
        var x = price(a), y = price(b);
        if (x === null) return 1; if (y === null) return -1;
        return state.sort === 'low' ? x - y : y - x;
      });
    }
    // Sold-out items always go last.
    return l.sort(function (a, b) { return (a.in_stock === false) - (b.in_stock === false); });
  }
  function catsPresent() {
    var seen = {};
    shop.products.forEach(function (p) { if (p.category && CAT_NAMES[p.category]) seen[p.category] = (seen[p.category] || 0) + 1; });
    return Object.keys(CAT_NAMES).filter(function (k) { return seen[k]; }).map(function (k) { return { id: k, name: CAT_NAMES[k], n: seen[k] }; });
  }
  function sizesPresent() {
    var all = {}, one = false;
    shop.products.forEach(function (p) { if (!p.sizes.length) one = true; p.sizes.forEach(function (z) { all[z] = true; }); });
    var list = Object.keys(all).sort(function (a, b) {
      var x = SIZE_ORDER.indexOf(a.toUpperCase()), y = SIZE_ORDER.indexOf(b.toUpperCase());
      return (x === -1 ? 99 : x) - (y === -1 ? 99 : y) || a.localeCompare(b);
    });
    if (one && list.length) list.push('One size');
    return list;
  }
  function setCat(c) { state.cat = c; render(); }

  function renderCats() {
    catsBox.textContent = '';
    var cats = catsPresent();
    if (!cats.length) { catsBox.hidden = true; return; }
    catsBox.hidden = false;
    [{ id: '', name: 'All merch', n: shop.products.length }].concat(cats).forEach(function (c) {
      catsBox.appendChild(el('button', { type: 'button', class: 'shop-cat', 'aria-pressed': state.cat === c.id ? 'true' : 'false', onclick: function () { setCat(c.id); } }, [
        c.name, el('small', { text: String(c.n) })
      ]));
    });
  }

  function group(title, nodes, extra) {
    return el('div', { class: 'sf-group' }, [el('div', { class: 'sf-head' }, [el('b', { text: title }), extra || null])].concat(nodes));
  }
  function renderFilters() {
    filtersBox.textContent = '';
    var any = state.cat || state.sizes.length || state.price || state.stock;
    filtersBox.appendChild(el('div', { class: 'sf-top' }, [
      el('b', { text: 'Filters' }),
      any ? el('button', { type: 'button', class: 'sf-clear', text: 'Clear all', onclick: function () { state = { cat: '', sizes: [], price: '', stock: false, sort: state.sort }; render(); } }) : null
    ]));
    var cats = catsPresent();
    if (cats.length) {
      filtersBox.appendChild(group('Category', [{ id: '', name: 'All merch' }].concat(cats).map(function (c) {
        var n = shop.products.filter(function (p) { return (!c.id || p.category === c.id) && matches(p, 'cat'); }).length;
        return el('label', { class: 'sf-radio' }, [
          el('input', { type: 'radio', name: 'sfcat', checked: state.cat === c.id, onchange: function () { setCat(c.id); } }),
          el('span', { text: c.name }), el('small', { text: String(n) })
        ]);
      })));
    }
    var sizes = sizesPresent();
    if (sizes.length) {
      filtersBox.appendChild(group('Size', [el('div', { class: 'sf-sizes' }, sizes.map(function (z) {
        var on = state.sizes.indexOf(z) !== -1;
        return el('button', { type: 'button', class: 'sf-size', 'aria-pressed': on ? 'true' : 'false', text: z, onclick: function () {
          if (on) state.sizes.splice(state.sizes.indexOf(z), 1); else state.sizes.push(z);
          render();
        } });
      }))]));
    }
    var bands = PRICE_BANDS.map(function (b) {
      return { b: b, n: shop.products.filter(function (p) { return b.test(p.price_cents) && matches(p, 'price'); }).length, all: shop.products.filter(function (p) { return b.test(p.price_cents); }).length };
    }).filter(function (x) { return x.all > 0; });
    if (bands.length > 1 || state.price) {
      var max = Math.max.apply(null, bands.map(function (x) { return x.n; }).concat([1]));
      filtersBox.appendChild(group('Price', [el('div', { class: 'sf-bars', 'aria-hidden': 'true' }, bands.map(function (x) {
        return el('i', { class: state.price === x.b.id ? 'on' : '', style: 'height:' + Math.max(8, Math.round(x.n / max * 100)) + '%' });
      }))].concat(bands.map(function (x) {
        return el('label', { class: 'sf-radio' }, [
          el('input', { type: 'radio', name: 'sfprice', checked: state.price === x.b.id, onclick: function () { state.price = state.price === x.b.id ? '' : x.b.id; render(); } }),
          el('span', { text: x.b.label }), el('small', { text: String(x.n) })
        ]);
      }))));
    }
    if (shop.products.some(function (p) { return p.in_stock === false; })) {
      filtersBox.appendChild(group('Availability', [el('label', { class: 'sf-toggle' }, [
        el('span', { text: 'In stock only' }),
        el('input', { type: 'checkbox', role: 'switch', checked: state.stock, onchange: function (e) { state.stock = e.target.checked; render(); } }),
        el('i', { 'aria-hidden': 'true' })
      ])]));
    }
    filtersBox.appendChild(el('div', { class: 'sf-help' }, [
      el('b', { text: 'Need help?' }),
      el('p', { text: 'Sizes, bulk orders for your crew, or something you want back in stock — message us on WhatsApp.' }),
      el('a', { href: enquireUrl({ name: 'merch' }).replace(/text=.*/, 'text=' + encodeURIComponent('Hi! I have a question about your merch.')), target: '_blank', rel: 'noopener', text: 'Chat on WhatsApp →' })
    ]));
  }

  function renderFeature() {
    var box = document.getElementById('shopFeature');
    var p = shop.products.filter(function (x) { return x.id === newestId; })[0];
    if (!p) { box.hidden = true; return; }
    box.textContent = '';
    box.href = '/shop?item=' + p.id;
    box.appendChild(el('span', { class: 'sfeat-img', style: p.photo_ids.length ? "background-image:url('" + photo(p.photo_ids[0], true) + "')" : '' }));
    box.appendChild(el('span', { class: 'sfeat-txt' }, [el('small', { text: 'New drop' }), el('b', { text: p.name }), el('span', { text: priceText(p) })]));
    box.appendChild(el('span', { class: 'sfeat-go', 'aria-hidden': 'true', text: '→' }));
    box.onclick = function (e) { e.preventDefault(); showItem(p); };
    box.hidden = false;
  }

  function quickAdd(p) {
    if (!priced(p) || p.sizes.length > 1) { showItem(p); return; }
    var size = p.sizes[0] || '';
    var same = bag.filter(function (l) { return l.product_id === p.id && l.size === size; })[0];
    if (same) same.qty = Math.min(20, same.qty + 1); else bag.push({ product_id: p.id, size: size, qty: 1 });
    saveBag();
    showBag(p.name + ' added.');
  }

  function render() {
    grid.textContent = '';
    if (!shop.open || !shop.products.length) {
      catsBox.hidden = true; filtersBox.hidden = true;
      document.querySelector('.shop-toolbar').hidden = true;
      grid.appendChild(el('div', { class: 'empty-state' }, [el('b', { text: tx('shop_empty', 'New merch is on the way.') })]));
      return;
    }
    renderCats();
    renderFilters();
    var list = sorted(shop.products.filter(function (p) { return matches(p); }));
    countEl.textContent = list.length === shop.products.length ? list.length + (list.length === 1 ? ' item' : ' items') : list.length + ' of ' + shop.products.length + ' items';
    if (!list.length) {
      grid.appendChild(el('div', { class: 'empty-state' }, [el('b', { text: 'Nothing matches those filters.' }),
        el('button', { type: 'button', class: 'btn btn-outline', text: 'Clear filters', onclick: function () { state = { cat: '', sizes: [], price: '', stock: false, sort: state.sort }; render(); } })]));
      return;
    }
    var delivery = tx('shop_delivery_short', '14 days');
    list.forEach(function (p) {
      grid.appendChild(R.merchCard(p, { newest: newestId, delivery: delivery, onOpen: showItem, onAction: function (x) {
        if (!priced(x)) { window.open(enquireUrl(x), '_blank', 'noopener'); return; }
        quickAdd(x);
      } }));
    });
  }
  sortSel.addEventListener('change', function () { state.sort = sortSel.value; render(); });
  filterToggle.addEventListener('click', function () {
    var open = filtersBox.classList.toggle('open');
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('bagPill').addEventListener('click', showBag);

  function showItem(p) {
    if (p.in_stock === false) {
      open([
        photoStrip(p),
        el('div', { class: 'shop-item-head' }, [el('h2', { class: 'shop-h', id: 'sheetTitle', text: p.name }), el('span', { class: 'price soon', text: 'Sold out' })]),
        p.description ? el('p', { class: 'shop-desc', text: p.description }) : null,
        el('p', { class: 'shop-desc', text: 'This one has sold out. Message us on WhatsApp and we’ll tell you when it’s back.' }),
        el('a', { class: 'btn btn-primary btn-block', href: enquireUrl(p).replace(/text=.*/, 'text=' + encodeURIComponent('Hi! Please let me know when the ' + p.name + ' is back in stock.')), target: '_blank', rel: 'noopener', text: 'Tell me when it’s back' })
      ]);
      return;
    }
    if (!priced(p)) {
      open([
        photoStrip(p),
        el('div', { class: 'shop-item-head' }, [el('h2', { class: 'shop-h', id: 'sheetTitle', text: p.name }), el('span', { class: 'price soon', text: priceText(p) })]),
        p.description ? el('p', { class: 'shop-desc', text: p.description }) : null,
        el('p', { class: 'shop-desc', text: tx('shop_soon_text', "This item isn't on sale online yet. Message us on WhatsApp to reserve one or to hear first when it's available.") }),
        el('a', { class: 'btn btn-primary btn-block', href: enquireUrl(p), target: '_blank', rel: 'noopener', text: tx('shop_enquire', 'Enquire on WhatsApp') })
      ]);
      return;
    }
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
      deliveryNote()
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
      note ? el('p', { class: 'shop-ok' }, [icon('check'), note]) : null,
      list,
      el('div', { class: 'bag-total' }, [el('span', { text: 'Total' }), el('b', { text: money(bagTotal()) })]),
      deliveryNote(),
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
    form.appendChild(el('p', { class: 'co-terms' }, ['By placing your order you agree to our ', el('a', { href: '/terms#shop', target: '_blank', text: 'Terms' }), ' and ', el('a', { href: '/returns#merch', target: '_blank', text: 'Returns policy' }), '. See how we use your details in our ', el('a', { href: '/privacy', target: '_blank', text: 'Privacy Policy' }), '.']));
    form.appendChild(btn);
    form.appendChild(deliveryNote());
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
      nodes = [el('div', { class: 'order-big ok' }, [icon('check')]), el('p', { class: 'shop-desc', text: tx('shop_thanks', 'Thank you! Your order is paid. We’ll deliver within 14 days.') }), ref, summary(o),
        el('button', { class: 'btn btn-outline btn-block', type: 'button', text: 'Back to the shop', onclick: function () { close(); history.replaceState(null, '', '/shop'); } })];
      open(nodes, 'Payment received');
      return;
    }
    if (o.status === 'failed' || o.status === 'cancelled') {
      nodes = [el('div', { class: 'order-big bad' }, [icon('alert')]),
        el('p', { class: 'shop-desc', text: (o.error ? o.error + '. ' : '') + 'The payment didn’t go through, so nothing was taken. Your bag is still saved.' }), ref,
        el('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Try again', onclick: showCheckout })];
      open(nodes, 'Payment not completed');
      return;
    }
    if (o.pay_method === 'manual') {
      bag = []; saveBag();
      nodes = [el('div', { class: 'order-big ok' }, [icon('check')]), el('p', { class: 'shop-desc', text: 'Your order is in. To finish, pay ' + money(o.total_cents) + ' as shown below and use ' + o.ref + ' as the reference.' }),
        o.manual ? el('div', { class: 'order-manual', text: o.manual }) : null, ref, summary(o),
        deliveryNote(' after payment.')];
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
    var recent = shop.products.filter(function (p) { return p.in_stock !== false; }).sort(function (a, b) { return b.id - a.id; })[0];
    newestId = recent ? recent.id : null;
    sortSel.value = state.sort;
    renderFeature();
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

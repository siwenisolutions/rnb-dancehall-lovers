(function () {
  'use strict';
  var R = window.RNB, el = R.el;
  var upcomingList = document.getElementById('upcomingList');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- slideshows ----------
  // Puts up to 5 photos inside a box and fades between them. If a video is
  // given (header only), it plays muted on a loop instead.
  function slideshow(box, items, opts) {
    opts = opts || {};
    if (!box || !items || !items.length) return;
    // The server already put the header video in the page so it starts at once:
    // keep it playing rather than starting it again.
    var ssr = box.querySelector(':scope > .slides[data-ssr-video]');
    if (ssr && opts.video && items.some(function (i) { return String(i.id) === ssr.getAttribute('data-ssr-video'); })) {
      var sv = ssr.querySelector('video');
      if (sv && sv.paused) { sv.muted = true; var pp = sv.play(); if (pp && pp.catch) pp.catch(function () {}); }
      return;
    }
    var old = box.querySelector(':scope > .slides');
    if (old) old.remove();
    var wrap = el('div', { class: 'slides', 'aria-hidden': 'true' });
    var video = opts.video && items.filter(function (i) { return /^video\//.test(i.mime || ''); })[0];
    if (video) {
      var v = el('video', { class: 'slide on', src: (opts.videoBase || '') + '/media/' + video.id, autoplay: true, loop: true, playsinline: true, preload: 'auto' });
      v.muted = true;
      wrap.appendChild(v);
      box.insertBefore(wrap, box.firstChild);
      box.classList.add('has-slides');
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked: first frame still shows */ });
      return;
    }
    var photos = items.filter(function (i) { return !/^video\//.test(i.mime || ''); }).slice(0, 5);
    if (!photos.length) return;
    var slides = photos.map(function (ph, i) {
      return el('div', { class: 'slide' + (i === 0 ? ' on' : ''), style: "background-image:url('" + R.mediaUrl(ph.id, opts.thumb) + "')" });
    });
    slides.forEach(function (s) { wrap.appendChild(s); });
    box.insertBefore(wrap, box.firstChild);
    box.classList.add('has-slides');
    if (slides.length < 2 || reduceMotion) return;
    var i = 0;
    var period = 4500 + Math.random() * 2500;
    setTimeout(function () {
      setInterval(function () {
        if (document.hidden) return;
        slides[i].classList.remove('on');
        i = (i + 1) % slides.length;
        slides[i].classList.add('on');
      }, period);
    }, Math.random() * 2000);
  }

  // ---------- sections ----------
  function renderUpcoming(events, settings) {
    upcomingList.textContent = '';
    if (!events.length) {
      var ig = R.safeLink(settings.instagram_url);
      upcomingList.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1; margin-top:0;' }, [
        el('b', { text: R.t('upcoming_empty_title') }),
        R.t('upcoming_empty_text'),
        el('br'),
        ig ? el('a', { class: 'btn btn-primary', href: ig, target: '_blank', rel: 'noopener', text: '@rnbdancehalllovers →' }) : null
      ]));
      return;
    }
    events.forEach(function (ev) { upcomingList.appendChild(R.eventCard(ev)); });
  }

  function renderExperience(slots, s) {
    var cards = document.querySelectorAll('#expRow .exp-card');
    ['exp1', 'exp2', 'exp3'].forEach(function (key, i) {
      var card = cards[i];
      if (!card) return;
      var cap = card.querySelector('.cap');
      if (cap && s[key + '_label'] !== undefined) {
        cap.textContent = s[key + '_label'];
        cap.hidden = !s[key + '_label'];
      }
      slideshow(card.querySelector('.photo'), slots[key], { thumb: true });
    });
  }

  function renderRecent(events) {
    if (!events.length) return; // keep the built-in photo cards
    var grid = document.getElementById('recentGrid');
    grid.textContent = '';
    events.forEach(function (ev) {
      var card = el('a', { class: 'case-card ph media', href: '/events/' + ev.id, style: 'background:linear-gradient(135deg,#5b266c,#c11fd6)' }, [
        el('div', { class: 'meta' }, [ev.title, el('small', { text: R.fmtDay(ev.starts_at) + ' ' + R.fmtMonth(ev.starts_at) + (ev.venue ? ' · ' + ev.venue : '') })])
      ]);
      grid.appendChild(card);
      var ids = (ev.photo_ids && ev.photo_ids.length) ? ev.photo_ids : (ev.cover_media_id ? [ev.cover_media_id] : []);
      slideshow(card, ids.map(function (id) { return { id: id, mime: 'image/webp' }; }), { thumb: true });
    });
  }

  // Ticket cards: only tickets that are still on sale (the server leaves out
  // events that have happened), soonest first, each with its own slideshow.
  function renderTickets(tickets, slots) {
    var grid = document.getElementById('ticketGrid');
    var cards = (tickets || []).map(function (tk) {
      var url = R.safeLink(tk.url);
      if (!url) return null;
      var title = tk.title || R.t('site_name');
      var host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
      var thumb = el('div', { class: 'ticket-thumb' + (tk.card ? ' ticket-thumb-' + tk.card : '') }, [el('span', { class: 'ticket-chip', text: R.t('ticket_chip') })]);
      var sub, label;
      if (tk.kind === 'event') {
        sub = R.fmtDay(tk.starts_at) + ' ' + R.fmtMonth(tk.starts_at) + (tk.venue ? ' · ' + tk.venue : '');
        label = R.t('ticket_btn') || 'Get Tickets';
        slideshow(thumb, (tk.photo_ids || []).map(function (id) { return { id: id, mime: 'image/webp' }; }));
        if (!(tk.photo_ids || []).length) thumb.style.background = 'linear-gradient(135deg,#5b266c,#c11fd6)';
      } else {
        sub = tk.subtitle || host;
        label = tk.label || R.t('ticket_btn') || 'Get Tickets';
        slideshow(thumb, slots['ticket' + tk.card]);
      }
      return el('a', { class: 'ticket-card', href: url, target: '_blank', rel: 'noopener', 'aria-label': title + ': get tickets (opens ' + host + ')' }, [
        thumb,
        el('div', { class: 'ticket-body' }, [
          el('div', { class: 'ticket-sub', text: sub }),
          el('h3', { text: title }),
          el('span', { class: 'btn btn-primary', text: label + ' →' })
        ])
      ]);
    }).filter(Boolean);
    var section = document.getElementById('tickets');
    section.hidden = cards.length === 0;
    document.getElementById('heroTickets').hidden = cards.length === 0;
    grid.textContent = '';
    grid.classList.toggle('single', cards.length === 1);
    cards.forEach(function (c) { grid.appendChild(c); });
  }

  R.api('/api/home').then(function (data) {
    var s = data.settings || {};
    var slots = data.slots || {};
    if (s.hero_text) document.getElementById('heroText').textContent = s.hero_text;
    s.ticket_links = (data.tickets || []).map(function (tk) {
      var label = (tk.kind === 'card' && tk.label) || R.t('ticket_btn') || 'Get Tickets';
      // A card's button may already name the country, e.g. "Get Tickets (South Africa)".
      if (tk.country) label = label.replace(new RegExp('\\s*[(\\-–·,]*\\s*' + tk.country + '\\s*\\)?', 'i'), '').trim() || 'Get Tickets';
      var at = tk.starts_at || (tk.date ? tk.date + 'T12:00:00+02:00' : '');
      var when = at ? R.fmtDay(at) + ' ' + R.fmtMonth(at) : '';
      // "Harare" for a city; the event's name when only the country is known.
      var city = tk.place && tk.place !== tk.country ? tk.place.replace(/, [^,]+$/, '') : '';
      return { url: tk.url, tables_url: tk.tables_url || '', label: label, country: tk.country || '', flag: tk.flag || '', place: city || tk.title || '', title: tk.title || '', when: when };
    });
    R.renderFooter(s);
    slideshow(document.querySelector('.hero'), slots.hero, { video: true, videoBase: data.video_base });
    renderTickets(data.tickets, slots);
    renderUpcoming(data.upcoming || [], s);
    renderExperience(slots, s);
    slideshow(document.querySelector('.promo-photo'), slots.promo);
    // Photo backgrounds behind the two intro cards.
    ['intro1', 'intro2'].forEach(function (k) {
      var card = document.querySelector('[data-spot="' + k + '"]');
      if (card && slots[k] && slots[k].length) { card.classList.add('has-photo'); slideshow(card, slots[k], { thumb: true }); }
    });
    var joins = document.querySelectorAll('.join .join-panel');
    slideshow(joins[0], slots.join1, { thumb: true });
    slideshow(joins[1], slots.join2, { thumb: true });
    renderRecent(data.past || []);
  }).catch(function () {
    upcomingList.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1; margin-top:0;' }, [
      el('b', { text: 'Events are loading slowly' }), 'Please refresh the page in a moment.'
    ]));
  });

  // Merchandise: show the shop's items (newest first, up to 4) above the item pills.
  (function merch() {
    var box = document.getElementById('merchProducts');
    if (!box) return;
    R.api('/api/shop').then(function (shop) {
      var items = (shop && shop.open && shop.products) || [];
      if (!items.length) return;
      items.slice().sort(function (a, b) { return b.id - a.id; }).slice(0, 4).forEach(function (p, i) {
        var price = p.price_cents > 0 ? '$' + (p.price_cents % 100 ? (p.price_cents / 100).toFixed(2) : String(p.price_cents / 100)) : 'Price coming soon';
        box.appendChild(R.el('a', { class: 'merch-product', href: '/shop?item=' + p.id, 'aria-label': p.name + ', ' + price }, [
          R.el('div', { class: 'mp-img', style: p.photo_ids.length ? "background-image:url('" + R.mediaUrl(p.photo_ids[0], true) + "')" : '' }),
          R.el('div', { class: 'mp-body' }, [
            i === 0 ? R.el('span', { class: 'mp-new', text: 'New' }) : null,
            R.el('b', { text: p.name }),
            R.el('span', { class: 'price' + (p.price_cents > 0 ? '' : ' soon'), text: price })
          ])
        ]));
      });
      box.hidden = false;
    }).catch(function () { /* the pills still show */ });
  })();
})();

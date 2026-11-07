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
    var old = box.querySelector(':scope > .slides');
    if (old) old.remove();
    var wrap = el('div', { class: 'slides', 'aria-hidden': 'true' });
    var video = opts.video && items.filter(function (i) { return /^video\//.test(i.mime || ''); })[0];
    if (video) {
      var v = el('video', { class: 'slide on', src: R.mediaUrl(video.id), autoplay: true, loop: true, playsinline: true, preload: 'auto' });
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
        el('b', { text: 'New dates coming soon' }),
        'Follow us on Instagram to be the first to know about our next night.',
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

  // Ticket cards: one per ticket link set in the admin panel, each with its own slideshow.
  function renderTickets(s, slots) {
    var grid = document.getElementById('ticketGrid');
    var cards = [1, 2].map(function (n) {
      var url = R.safeLink(s['ticket' + n + '_url']);
      if (!url) return null;
      var title = s['ticket' + n + '_title'] || 'RNB Dancehall Lovers';
      var host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
      var thumb = el('div', { class: 'ticket-thumb ticket-thumb-' + n }, [el('span', { class: 'ticket-chip', text: 'Tickets on sale' })]);
      slideshow(thumb, slots['ticket' + n]);
      return el('a', { class: 'ticket-card', href: url, target: '_blank', rel: 'noopener', 'aria-label': title + ': get tickets (opens ' + host + ')' }, [
        thumb,
        el('div', { class: 'ticket-body' }, [
          el('div', { class: 'ticket-sub', text: s['ticket' + n + '_subtitle'] || host }),
          el('h3', { text: title }),
          el('span', { class: 'btn btn-primary', text: (s['ticket' + n + '_label'] || 'Get Tickets') + ' →' })
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
    if (s.about_text) document.getElementById('aboutText').textContent = s.about_text;
    R.renderFooter(s);
    slideshow(document.querySelector('.hero'), slots.hero, { video: true });
    renderTickets(s, slots);
    renderUpcoming(data.upcoming || [], s);
    renderExperience(slots, s);
    slideshow(document.querySelector('.promo-photo'), slots.promo);
    var joins = document.querySelectorAll('.join .join-panel');
    slideshow(joins[0], slots.join1, { thumb: true });
    slideshow(joins[1], slots.join2, { thumb: true });
    renderRecent(data.past || []);
  }).catch(function () {
    upcomingList.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1; margin-top:0;' }, [
      el('b', { text: 'Events are loading slowly' }), 'Please refresh the page in a moment.'
    ]));
  });
})();

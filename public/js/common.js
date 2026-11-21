/* Shared by every public page: header, footer, data helpers, event cards, lightbox. */
(function () {
  'use strict';

  var TZ = 'Africa/Harare';
  var DEFAULTS = {
    contact_email: 'rnbdancehalllovers@rnbdancehalllovers.co.zw',
    phone: '077 167 4200',
    address: '383 Glen Helen Way, Glen Lorne, Harare, Zimbabwe',
    instagram_url: 'https://www.instagram.com/rnbdancehalllovers/',
    facebook_url: '', tiktok_url: '', youtube_url: '',
    whatsapp_url: 'https://whatsapp.com/channel/0029Vb6xj0D47Xe6bVFhv92q',
    ticket1_label: 'Get Tickets', ticket1_url: '',
    ticket2_label: '', ticket2_url: ''
  };

  // The admin panel's Website text preview (see edit-mode.js).
  var EDIT = window.RNB_EDIT === true;

  // Count this page view (no cookies; see visits.js on the server).
  if (!EDIT) try {
    var hit = JSON.stringify({ p: location.pathname, r: document.referrer });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/hit', hit);
    else fetch('/api/hit', { method: 'POST', body: hit, keepalive: true });
  } catch (e) { /* counting is optional */ }

  // Website words set in the admin panel (Website text). The server puts them
  // in the page as JSON; t(key) returns one.
  var TEXT = {};
  try { TEXT = JSON.parse((document.getElementById('rnb-text') || {}).textContent || '{}'); } catch (e) { TEXT = {}; }
  // In the preview each word comes with invisible markers naming its key,
  // so edit-mode.js can make it tappable wherever the scripts put it.
  function t(key) {
    var v = TEXT[key] !== undefined ? TEXT[key] : '';
    return EDIT && v ? '\uE000' + key + '\uE001' + v + '\uE002' : v;
  }

  // Tiny DOM builder. Text is always set with textContent, never innerHTML,
  // so anything typed in the admin panel is shown as plain text.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function api(path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('Request failed: ' + r.status);
      return r.json();
    });
  }

  function mediaUrl(id, thumb) {
    return '/media/' + encodeURIComponent(id) + '.webp' + (thumb ? '?size=thumb' : '');
  }

  function fmt(iso, opts) {
    var o = { timeZone: TZ };
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    return new Intl.DateTimeFormat('en-GB', o).format(new Date(iso));
  }
  function fmtDay(iso) { return fmt(iso, { day: '2-digit' }); }
  function fmtMonth(iso) { return fmt(iso, { month: 'short' }); }
  function fmtLong(iso) {
    return fmt(iso, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) +
      ' · ' + fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function safeLink(url) {
    try {
      var u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : '';
    } catch (e) { return ''; }
  }

  // ---------- header ----------
  function renderHeader() {
    var header = document.querySelector('header[data-site]');
    if (!header) return;
    var links = [['/#tickets', t('nav_tickets')], ['/#upcoming', t('nav_upcoming')], ['/events', t('nav_events')], ['/gallery', t('nav_gallery')], ['/#experience', t('nav_experiences')]];
    var nav = el('nav', { class: 'nav-links', id: 'navLinks' }, links.map(function (l) {
      return el('a', { href: l[0], text: l[1] });
    }));
    var burger = el('button', { class: 'burger', id: 'burgerBtn', 'aria-label': 'Toggle menu', 'aria-expanded': 'false' },
      [el('span'), el('span'), el('span')]);
    header.appendChild(el('div', { class: 'nav' }, [
      el('a', { class: 'logo', href: '/' }, [el('img', { src: '/img/logo.png', alt: t('site_name'), width: '60', height: '49' })]),
      nav,
      el('div', { class: 'nav-cta' }),
      burger
    ]));

    burger.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      burger.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.classList.remove('is-open');
        burger.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      });
    });

    var hero = document.querySelector('.hero');
    function onScroll() {
      var threshold = hero ? hero.offsetHeight - 80 : 40;
      header.classList.toggle('is-scrolled', window.scrollY > threshold);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---------- social icons ----------
  var SOCIALS = [
    ['instagram_url', 'ig', 'Instagram'], ['facebook_url', 'fb', 'Facebook'], ['tiktok_url', 'tt', 'TikTok'],
    ['whatsapp_url', 'wa', 'WhatsApp channel'], ['youtube_url', 'yt', 'YouTube']
  ];
  var ICONS = {
    ig: '<rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.6" r="1.3" fill="currentColor"/>',
    fb: '<path fill="currentColor" d="M13.6 21v-7.7h2.6l.4-3h-3V8.4c0-.9.3-1.5 1.5-1.5h1.6V4.2c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H7.9v3h2.6V21z"/>',
    tt: '<path fill="currentColor" d="M16.2 3c.4 2.2 1.8 3.7 4.1 3.9v3.2a7.4 7.4 0 0 1-4.1-1.3v6.1a6 6 0 1 1-6-6c.3 0 .7 0 1 .1v3.3a2.8 2.8 0 1 0 2 2.6V3z"/>',
    wa: '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M4.2 19.8l1.1-3.9a8.2 8.2 0 1 1 3 2.9z"/><path fill="currentColor" d="M9.3 7.6c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.7 1.6c.1.2 0 .4-.1.6l-.5.6c-.1.1-.1.3 0 .5a6 6 0 0 0 2.6 2.4c.2.1.3.1.5-.1l.6-.7c.1-.2.3-.2.5-.1l1.6.8c.2.1.3.2.3.4v.5c0 .3-.1.6-.4.8a2.5 2.5 0 0 1-2.1.4 7.6 7.6 0 0 1-5.3-5.1c-.2-.8 0-1.5.4-2z"/>',
    yt: '<rect x="2.5" y="5.5" width="19" height="13" rx="4" fill="currentColor"/><path fill="#fff" d="M10.2 9.2v5.6l4.8-2.8z"/>'
  };
  function icon(name) {
    var span = document.createElement('span');
    span.className = 'soc-ic';
    span.setAttribute('aria-hidden', 'true');
    // Fixed markup from ICONS above, never from the admin panel.
    span.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20">' + ICONS[name] + '</svg>';
    return span;
  }

  // ---------- footer ----------
  function renderFooter(s) {
    var footer = document.querySelector('footer[data-site]');
    if (!footer) return;
    s = Object.assign({}, DEFAULTS, s || {});
    footer.textContent = '';

    var socials = SOCIALS
      .filter(function (x) { return safeLink(s[x[0]]); })
      .map(function (x) {
        return el('a', { class: 'soc soc-' + x[1], href: safeLink(s[x[0]]), target: '_blank', rel: 'noopener', 'aria-label': x[2], title: x[2] }, [icon(x[1])]);
      });

    var tel = s.phone ? '+263' + s.phone.replace(/\D/g, '').replace(/^(263|0)/, '') : '';
    var contact = [el('h4', { text: t('footer_contact') })];
    if (s.contact_email) {
      // mailto: only works when the device has an email app set up, so also
      // offer Gmail in the browser and a copy button.
      var email = s.contact_email;
      var copyBtn = el('button', { type: 'button', class: 'mail-opt', text: 'Copy' });
      copyBtn.addEventListener('click', function () {
        var done = function () { copyBtn.textContent = 'Copied!'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000); };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(email).then(done, function () { window.prompt('Copy this email address:', email); });
        else window.prompt('Copy this email address:', email);
      });
      contact.push(el('a', { href: 'mailto:' + email, text: email, style: 'word-break:break-all;' }));
      contact.push(el('div', { class: 'mail-opts' }, [
        el('a', { class: 'mail-opt', href: 'mailto:' + email, text: 'Email app' }),
        el('a', { class: 'mail-opt', href: 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(email), target: '_blank', rel: 'noopener', text: 'Gmail' }),
        copyBtn
      ]));
    }
    if (s.phone) contact.push(el('a', { href: 'tel:' + tel, text: s.phone }));
    var buttons = [];
    if (safeLink(s.instagram_url)) {
      buttons.push(el('a', { class: 'btn btn-cta', href: safeLink(s.instagram_url), target: '_blank', rel: 'noopener', text: '@rnbdancehalllovers →' }));
    }
    // Only tickets still on sale (the home page passes them in), each saying
    // where it is so people pick the right country.
    (s.ticket_links || []).forEach(function (tk) {
      var url = safeLink(tk.url);
      if (!url) return;
      var where = [tk.place || tk.title, tk.when].filter(Boolean).join(' · ');
      buttons.push(el('a', { class: 'btn btn-outline btn-ticket', href: url, target: '_blank', rel: 'noopener' }, [
        tk.flag ? el('span', { class: 'flag', 'aria-hidden': 'true', text: tk.flag }) : null,
        el('span', { class: 'bt-txt' }, [
          el('b', { text: tk.label + (tk.country ? ' · ' + tk.country : '') }),
          where ? el('small', { text: where }) : null
        ]),
        el('span', { class: 'bt-arrow', 'aria-hidden': 'true', text: '→' })
      ]));
      var tables = safeLink(tk.tables_url);
      if (tables) {
        buttons.push(el('a', { class: 'btn btn-outline btn-ticket btn-tables', href: tables, target: '_blank', rel: 'noopener' }, [
          tk.flag ? el('span', { class: 'flag', 'aria-hidden': 'true', text: tk.flag }) : null,
          el('span', { class: 'bt-txt' }, [
            el('b', { text: (t('tables_btn') || 'Buy Tables') + (tk.country ? ' · ' + tk.country : '') }),
            where ? el('small', { text: where }) : null
          ]),
          el('span', { class: 'bt-arrow', 'aria-hidden': 'true', text: '→' })
        ]));
      }
    });
    contact.push(el('div', { class: 'footer-buttons', style: 'margin-top:14px;' }, buttons));

    footer.appendChild(el('div', { class: 'wrap' }, [
      el('div', { class: 'footer-grid' }, [
        el('div', { class: 'footer-col footer-brand' }, [
          el('div', { class: 'logo' }, [el('img', { src: '/img/logo.png', alt: t('site_name'), style: 'width:60px;' })]),
          el('div', { class: 'footer-socials' }, socials),
          el('p', { text: t('site_name') + (s.address ? ' · ' + s.address : '') })
        ]),
        el('div', { class: 'footer-col' }, [
          el('h4', { text: t('footer_events') }),
          el('a', { href: '/events#upcoming', text: t('footer_upcoming') }),
          el('a', { href: '/events#past', text: t('footer_past') }),
          el('a', { href: '/gallery', text: t('footer_gallery') }),
          el('a', { href: '/gallery?category=experience', text: t('footer_experience') })
        ]),
        el('div', { class: 'footer-col' }, [
          el('h4', { text: t('footer_visit') }),
          el('a', { href: 'https://maps.google.com/?q=' + encodeURIComponent(s.address || ''), target: '_blank', rel: 'noopener', text: s.address || 'Harare, Zimbabwe' })
        ]),
        el('div', { class: 'footer-col' }, contact)
      ]),
      el('div', { class: 'footer-bottom' }, [
        el('span', { text: '© ' + new Date().getFullYear() + ' ' + t('site_name') + (t('footer_place') ? ' · ' + t('footer_place') : '') })
      ])
    ]));
  }

  // The event's flyers: its poster, plus the tickets and tables flyers when
  // it has them. Tapping a flyer goes where it says (event page, ticket site,
  // table booking).
  function flyersOf(ev) {
    var ticket = safeLink(ev.ticket_url), tables = safeLink(ev.tables_url);
    var out = [{ kind: 'main', id: ev.cover_media_id, href: '/events/' + ev.id }];
    if (ev.tickets_flyer_id) out.push({ kind: 'tickets', id: ev.tickets_flyer_id, href: ticket || '/events/' + ev.id, out: !!ticket, tag: t('flyer_tag_tickets') || 'Tickets' });
    if (ev.tables_flyer_id) out.push({ kind: 'tables', id: ev.tables_flyer_id, href: tables || '/events/' + ev.id, out: !!tables, tag: t('flyer_tag_tables') || 'Tables' });
    return out;
  }
  function flyerStrip(ev, thumb) {
    var flyers = flyersOf(ev);
    var strip = el('div', { class: 'flyer-strip' });
    flyers.forEach(function (f) {
      var a = el('a', { class: 'poster flyer ' + (f.id ? 'ph media' : 'empty'), href: f.href, 'aria-label': ev.title + (f.tag ? ': ' + f.tag : '') },
        f.id ? [] : [el('span', { text: ev.title })]);
      if (f.out) { a.target = '_blank'; a.rel = 'noopener'; }
      if (f.id) a.style.backgroundImage = "url('" + mediaUrl(f.id, thumb) + "')";
      if (f.tag) a.appendChild(el('span', { class: 'flyer-tag', text: f.tag + (f.out ? ' →' : '') }));
      strip.appendChild(a);
    });
    var wrap = el('div', { class: 'flyers' + (flyers.length > 1 ? ' many' : '') }, [strip]);
    if (flyers.length > 1) {
      var dots = el('div', { class: 'flyer-dots', 'aria-hidden': 'true' }, flyers.map(function (f, i) { return el('span', { class: i ? '' : 'on' }); }));
      wrap.appendChild(dots);
      strip.addEventListener('scroll', function () {
        var i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
        [].forEach.call(dots.children, function (d, j) { d.className = j === i ? 'on' : ''; });
      }, { passive: true });
    }
    return wrap;
  }
  function eventButtons(ev, cls, ticketText) {
    var out = [];
    var ticket = safeLink(ev.ticket_url), tables = safeLink(ev.tables_url);
    if (ticket) out.push(el('a', { class: 'btn btn-primary ' + (cls || ''), href: ticket, target: '_blank', rel: 'noopener', text: ticketText || t('ticket_btn') || 'Get Tickets' }));
    if (tables) out.push(el('a', { class: 'btn btn-dark ' + (cls || ''), href: tables, target: '_blank', rel: 'noopener', text: t('tables_btn') || 'Buy Tables' }));
    return out;
  }

  // ---------- event card ----------
  function eventCard(ev) {
    var flyers = flyerStrip(ev, true);
    flyers.appendChild(el('div', { class: 'date-badge' }, [el('b', { text: fmtDay(ev.starts_at) }), el('small', { text: fmtMonth(ev.starts_at) })]));
    var actions = eventButtons(ev).concat([el('a', { class: 'btn btn-outline', href: '/events/' + ev.id, text: 'Details' })]);
    return el('article', { class: 'event-card' }, [
      flyers,
      el('div', { class: 'body' }, [
        el('h3', { text: ev.title }),
        el('div', { class: 'when', text: fmtLong(ev.starts_at) }),
        ev.venue ? el('div', { class: 'when', text: ev.venue }) : null,
        el('div', { class: 'actions' }, actions)
      ])
    ]);
  }

  // ---------- lightbox ----------
  var lb, lbImg, lbCap, lbDl, lbShare, lbNote, lbItems = [], lbIndex = 0;
  var IC_DL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  var IC_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8 15.8 6.2M8.2 13.2l7.6 4.6"/></svg>';
  function jpgUrl(id, download) { return '/media/' + encodeURIComponent(id) + '.jpg' + (download ? '?dl=1' : ''); }
  function photoPage(p) { return location.origin + (p.event_id ? '/events/' + p.event_id : '/gallery'); }
  // Share: the photo itself where the phone allows it (WhatsApp, Instagram,
  // etc.), otherwise a link to the event's page, otherwise copy the link.
  function sharePhoto() {
    var p = lbItems[lbIndex];
    if (!p) return;
    var title = p.event_title || t('site_name');
    var link = photoPage(p);
    function note(text) { lbNote.textContent = text; lbNote.hidden = false; setTimeout(function () { lbNote.hidden = true; }, 2500); }
    function shareLink() {
      if (navigator.share) return navigator.share({ title: title, text: title, url: link });
      if (navigator.clipboard) return navigator.clipboard.writeText(link).then(function () { note('Link copied'); });
      note(link);
      return Promise.resolve();
    }
    var go = (window.File && navigator.canShare)
      ? fetch(jpgUrl(p.id)).then(function (r) { return r.blob(); }).then(function (blob) {
        var file = new File([blob], 'RnB-Dancehall-Lovers-' + p.id + '.jpg', { type: 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: title, text: title + ' · ' + link });
        return shareLink();
      })
      : shareLink();
    go.catch(function (err) { if (!err || err.name !== 'AbortError') shareLink().catch(function () {}); });
  }
  function ensureLightbox() {
    if (lb) return;
    lbImg = el('img', { alt: '' });
    lbCap = el('figcaption');
    lb = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer' }, [
      el('figure', null, [lbImg, lbCap, el('div', { class: 'lb-actions' }, [
        lbDl = el('a', { class: 'lb-act', href: '#', download: '' }),
        lbShare = el('button', { class: 'lb-act', type: 'button', onclick: sharePhoto }),
        lbNote = el('span', { class: 'lb-note', hidden: true, 'aria-live': 'polite' })
      ])]),
      el('button', { class: 'lb-close', 'aria-label': 'Close', text: '×', onclick: closeLightbox }),
      el('button', { class: 'lb-prev', 'aria-label': 'Previous photo', text: '‹', onclick: function () { showLightbox(lbIndex - 1); } }),
      el('button', { class: 'lb-next', 'aria-label': 'Next photo', text: '›', onclick: function () { showLightbox(lbIndex + 1); } })
    ]);
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLightbox(); });
    // Swipe left/right to move between photos on phones.
    var touchX = null;
    lb.addEventListener('touchstart', function (e) { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) showLightbox(lbIndex + (dx < 0 ? 1 : -1));
    }, { passive: true });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') showLightbox(lbIndex - 1);
      if (e.key === 'ArrowRight') showLightbox(lbIndex + 1);
    });
    lbDl.innerHTML = IC_DL + '<span></span>';
    lbDl.querySelector('span').textContent = t('photo_download') || 'Download';
    lbShare.innerHTML = IC_SHARE + '<span></span>';
    lbShare.querySelector('span').textContent = t('photo_share') || 'Share';
    document.body.appendChild(lb);
  }
  function showLightbox(i) {
    if (!lbItems.length) return;
    lbIndex = (i + lbItems.length) % lbItems.length;
    var p = lbItems[lbIndex];
    lbImg.src = mediaUrl(p.id);
    lbDl.href = jpgUrl(p.id, true);
    lbDl.setAttribute('download', 'RnB-Dancehall-Lovers-' + p.id + '.jpg');
    lbImg.alt = p.caption || t('site_name') + ' photo';
    lbCap.textContent = [p.caption, p.event_title, (lbIndex + 1) + ' / ' + lbItems.length].filter(Boolean).join(' · ');
    // Load the next photo early so swiping feels instant.
    var next = lbItems[(lbIndex + 1) % lbItems.length];
    if (next) { var pre = new Image(); pre.src = mediaUrl(next.id); }
  }
  function openLightbox(items, i) {
    ensureLightbox();
    lbItems = items;
    showLightbox(i);
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
    lb.querySelector('.lb-close').focus();
  }
  function closeLightbox() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
  }

  // Photo grid used by the gallery and event pages.
  function galleryItem(items, i) {
    var p = items[i];
    return el('button', { class: 'gallery-item', type: 'button', 'aria-label': 'Open photo' + (p.caption ? ': ' + p.caption : ''), onclick: function () { openLightbox(items, i); } }, [
      el('img', { src: mediaUrl(p.id, true), alt: p.caption || '', loading: 'lazy', width: p.width, height: p.height }),
      p.caption ? el('span', { class: 'gcap', text: p.caption }) : null
    ]);
  }

  window.RNB = {
    t: t, el: el, api: api, mediaUrl: mediaUrl, fmtLong: fmtLong, fmtDay: fmtDay, fmtMonth: fmtMonth,
    safeLink: safeLink, eventCard: eventCard, flyerStrip: flyerStrip, eventButtons: eventButtons, galleryItem: galleryItem, renderFooter: renderFooter
  };

  renderHeader();
  renderFooter(null);
  if (!document.body.hasAttribute('data-no-settings')) {
    api('/api/settings').then(renderFooter).catch(function () { /* keep defaults */ });
  }
})();

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

  // Emojis (often pasted from Instagram captions) are left out of event and
  // photo text on the website; the admin panel keeps the words as typed.
  var EMOJI = /(?:[\u2600-\u27BF\u2B00-\u2BFF\u2300-\u23FF\uFE0F\u200D\u20E3]|\uD83C[\uDDE6-\uDDFF]|[\uD83C-\uD83E][\uDC00-\uDFFF])/g;
  var PLAIN_KEYS = { title: 1, venue: 1, description: 1, caption: 1, event_title: 1, name: 1 };
  function plain(v) {
    return String(v).replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').replace(/^\s*[*•\-–]+\s*|\s*[*]+\s*$/g, '').trim();
  }
  function cleanData(o) {
    if (Array.isArray(o)) return o.map(cleanData);
    if (o && typeof o === 'object') {
      Object.keys(o).forEach(function (k) {
        o[k] = PLAIN_KEYS[k] && typeof o[k] === 'string' ? plain(o[k]) : cleanData(o[k]);
      });
    }
    return o;
  }
  function api(path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('Request failed: ' + r.status);
      return r.json();
    }).then(cleanData);
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
    var links = [['/#tickets', t('nav_tickets')], ['/#upcoming', t('nav_upcoming')], ['/events', t('nav_events')], ['/gallery', t('nav_gallery')], ['/shop', t('nav_shop')], ['/#experience', t('nav_experiences')]];
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
      buttons.push(el('a', { class: 'btn btn-outline btn-ticket', href: url, target: '_blank', rel: 'noopener', 'data-ticket': '' }, [
        tk.flag ? el('span', { class: 'flag', 'aria-hidden': 'true', text: tk.flag }) : null,
        el('span', { class: 'bt-txt' }, [
          el('b', { text: tk.label + (tk.country ? ' · ' + tk.country : '') }),
          where ? el('small', { text: where }) : null
        ]),
        el('span', { class: 'bt-arrow', 'aria-hidden': 'true', text: '→' })
      ]));
      var tables = safeLink(tk.tables_url);
      if (tables) {
        buttons.push(el('a', { class: 'btn btn-outline btn-ticket btn-tables', href: tables, target: '_blank', rel: 'noopener', 'data-ticket': '' }, [
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
    if (!EDIT) contact.push(el('button', { type: 'button', class: 'updates-link', text: 'Get event updates on WhatsApp', onclick: function () { openUpdates(true); } }));

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
          el('a', { href: '/shop', text: t('footer_shop') }),
          el('a', { href: '/gallery?category=experience', text: t('footer_experience') })
        ]),
        el('div', { class: 'footer-col' }, [
          el('h4', { text: t('footer_visit') }),
          el('a', { href: 'https://maps.google.com/?q=' + encodeURIComponent(s.address || ''), target: '_blank', rel: 'noopener', text: s.address || 'Harare, Zimbabwe' })
        ]),
        el('div', { class: 'footer-col' }, contact)
      ]),
      el('div', { class: 'footer-bottom' }, [
        el('span', { text: '© ' + new Date().getFullYear() + ' ' + t('site_name') + '. All rights reserved.' + (t('footer_place') ? ' · ' + t('footer_place') : '') }),
        el('nav', { class: 'footer-legal', 'aria-label': 'Policies' }, [
          el('a', { href: '/terms', text: 'Terms of Use' }),
          el('a', { href: '/privacy', text: 'Privacy & Cookies' }),
          el('a', { href: '/returns', text: 'Tickets, Returns & Refunds' })
        ])
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
      if (f.out) { a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('data-ticket', ''); }
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
    if (ticket) out.push(el('a', { class: 'btn btn-primary ' + (cls || ''), href: ticket, target: '_blank', rel: 'noopener', 'data-ticket': '', text: ticketText || t('ticket_btn') || 'Get Tickets' }));
    if (tables) out.push(el('a', { class: 'btn btn-dark ' + (cls || ''), href: tables, target: '_blank', rel: 'noopener', 'data-ticket': '', text: t('tables_btn') || 'Buy Tables' }));
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

  // ---------- "Get event updates" (visitors share their contact, with consent) ----------
  var UPD_KEY = 'rnb-updates';
  function updState() { try { return JSON.parse(localStorage.getItem(UPD_KEY) || '{}'); } catch (e) { return {}; } }
  function setUpd(v) { try { localStorage.setItem(UPD_KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  var updOpen = false;
  function openUpdates(force) {
    if (updOpen || EDIT) return;
    var st = updState();
    if (!force && (st.done || (st.later && Date.now() - st.later < 7 * 864e5))) return;
    updOpen = true;
    var msg = el('p', { class: 'upd-msg', role: 'status' });
    var name = el('input', { type: 'text', name: 'name', maxlength: '80', autocomplete: 'name', placeholder: 'Your name', required: true, 'aria-label': 'Your name' });
    var phone = el('input', { type: 'tel', name: 'phone', autocomplete: 'tel', placeholder: 'WhatsApp number, e.g. 0771 234 567', 'aria-label': 'WhatsApp number' });
    var email = el('input', { type: 'email', name: 'email', autocomplete: 'email', placeholder: 'Email (optional)', 'aria-label': 'Email' });
    var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'upd-trap', 'aria-hidden': 'true' });
    var consent = el('input', { type: 'checkbox', name: 'consent' });
    var picks = ['events', 'tickets', 'merch'].map(function (k) {
      return el('label', { class: 'upd-chip' }, [el('input', { type: 'checkbox', value: k, checked: true }), el('span', { text: { events: 'New events', tickets: 'Ticket drops', merch: 'Merch' }[k] })]);
    });
    var send = el('button', { type: 'submit', class: 'upd-send', text: 'Keep me posted' });
    function close(later) {
      if (later) setUpd({ later: Date.now() });
      box.classList.remove('show');
      setTimeout(function () { box.remove(); updOpen = false; }, 250);
    }
    var form = el('form', { class: 'upd-form', novalidate: true }, [
      name, phone, email, trap,
      el('div', { class: 'upd-chips' }, picks),
      el('label', { class: 'upd-consent' }, [consent, el('span', { text: 'I agree to receive event news and offers from RnB Dancehall Lovers by WhatsApp or email. I can ask to stop at any time.' })]),
      msg, send
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = ''; msg.className = 'upd-msg';
      if (!name.value.trim()) { msg.textContent = 'Please add your name.'; name.focus(); return; }
      if (!phone.value.trim() && !email.value.trim()) { msg.textContent = 'Add a WhatsApp number or an email so we can reach you.'; phone.focus(); return; }
      if (!consent.checked) { msg.textContent = 'Please tick the box to agree to receive updates.'; return; }
      send.disabled = true; send.textContent = 'Saving…';
      fetch('/api/contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value, phone: phone.value, email: email.value, website: trap.value, consent: true, page: location.pathname,
          interests: picks.map(function (p) { var i = p.querySelector('input'); return i.checked ? i.value : null; }).filter(Boolean) })
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); })
        .then(function () {
          setUpd({ done: Date.now() });
          form.replaceWith(el('div', { class: 'upd-thanks' }, [el('b', { text: 'You’re on the list.' }), el('p', { text: 'We’ll let you know about the next event first.' })]));
          setTimeout(function () { close(false); }, 3500);
        })
        .catch(function (err) { msg.textContent = err.message; msg.className = 'upd-msg err'; send.disabled = false; send.textContent = 'Keep me posted'; });
    });
    var box = el('aside', { class: 'upd', role: 'dialog', 'aria-label': 'Get event updates' }, [
      el('button', { type: 'button', class: 'upd-x', 'aria-label': 'Not now', text: '×', onclick: function () { close(true); } }),
      el('p', { class: 'upd-kicker', text: 'Don’t miss the next one' }),
      el('h3', { text: 'Get event updates' }),
      el('p', { class: 'upd-sub', text: 'Line-ups, early tickets and merch drops, straight to your WhatsApp.' }),
      form
    ]);
    document.body.appendChild(box);
    requestAnimationFrame(function () { box.classList.add('show'); });
    setTimeout(function () { (force ? name : send).focus({ preventScroll: true }); }, 50);
  }
  // Ask once people have shown interest: after 25 seconds, or after reading most of a page.
  if (!EDIT && !/^\/admin/.test(location.pathname)) {
    setTimeout(function () { openUpdates(false); }, 25000);
    window.addEventListener('scroll', function onScroll() {
      var h = document.documentElement;
      if (h.scrollTop + window.innerHeight > h.scrollHeight * 0.65) { window.removeEventListener('scroll', onScroll); openUpdates(false); }
    }, { passive: true });
  }

  // ---------- Merch card (shop page and home page) ----------
  // A full-bleed photo card: tags on top, then name, details, a price pill
  // and a white button over a dark fade.
  var MC_ICONS = {
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    size: '<path d="M4 7h16v10H4z"/><path d="M8 7v3M12 7v4M16 7v3"/>',
    truck: '<path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3.5V16h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'
  };
  function mcIcon(n) { var s = document.createElement('span'); s.className = 'mc-ic'; s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<svg viewBox="0 0 24 24">' + MC_ICONS[n] + '</svg>'; return s; }
  var MC_CATS = { clothing: 'Clothing', headwear: 'Caps & hats', accessories: 'Accessories', drinkware: 'Cups & bottles' };
  function mcMoney(c) { var v = c / 100; return '$' + (v % 1 ? v.toFixed(2) : String(v)); }
  function merchCard(p, o) {
    o = o || {};
    var priced = p.price_cents > 0, sold = p.in_stock === false;
    var href = '/shop?item=' + p.id;
    var isNew = o.newest === p.id;
    var action = sold ? 'Sold out' : !priced ? 'Enquire' : o.actionText ? o.actionText : p.sizes.length > 1 ? 'Choose size' : 'Add to bag';
    var btn = el('button', { type: 'button', class: 'mcard-btn', disabled: sold, text: action, 'aria-label': action + ': ' + p.name });
    if (!sold) btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); (o.onAction || function () { location.href = href; })(p); });
    var link = el('a', { class: 'mcard-link', href: href, 'aria-label': p.name + ', ' + (priced ? mcMoney(p.price_cents) : 'price coming soon') + (sold ? ', sold out' : '') });
    if (o.onOpen) link.addEventListener('click', function (e) { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); o.onOpen(p); });
    var meta = [];
    if (p.category && MC_CATS[p.category]) meta.push(el('span', null, [mcIcon('tag'), MC_CATS[p.category]]));
    meta.push(el('span', null, [mcIcon('size'), p.sizes.length ? p.sizes.join(' · ') : 'One size']));
    if (o.delivery) meta.push(el('span', null, [mcIcon('truck'), o.delivery]));
    return el('article', { class: 'mcard' + (sold ? ' is-sold' : '') + (p.photo_ids.length ? '' : ' no-photo') }, [
      p.photo_ids.length ? el('div', { class: 'mcard-img', style: "background-image:url('" + mediaUrl(p.photo_ids[0], true) + "')" })
        : el('div', { class: 'mcard-img empty', 'aria-hidden': 'true' }, [el('span', { text: p.name })]),
      el('div', { class: 'mcard-tags' }, [
        sold ? el('span', { class: 'mtag sold', text: 'Sold out' }) : isNew ? el('span', { class: 'mtag new', text: 'New drop' }) : null
      ]),
      el('div', { class: 'mcard-body' }, [
        el('h3', { text: p.name }),
        el('div', { class: 'mcard-meta' }, meta),
        el('div', { class: 'mcard-foot' }, [
          el('span', { class: 'mcard-price' + (priced ? '' : ' soon') }, priced ? [mcMoney(p.price_cents)] : [el('span', { class: 'mp-long', text: 'Price ' }), 'soon']),
          btn
        ])
      ]),
      link
    ]);
  }

  // ---------- One quick step before the ticket site ----------
  // Tickets are sold on Megaticket, which keeps the buyer's details to itself.
  // So the first time someone taps a ticket link on this phone, we ask for
  // their name and WhatsApp number (needed) and, as a separate unticked
  // choice, whether they want event news. Then they go straight on.
  var TK_KEY = 'rnb-ticket-buyer';
  var TICKET_HOSTS = /megaticket|quicket|computicket|webtickets|tixafrica|eventbrite|howler|sahwigate|ticketpro|ticketbox/i;
  function tkSaved() { try { return JSON.parse(localStorage.getItem(TK_KEY) || 'null'); } catch (e) { return null; } }
  function isTicketLink(a) {
    if (!a || !a.href || a.hasAttribute('data-no-gate')) return false;
    if (a.hasAttribute('data-ticket')) return true;
    try { var u = new URL(a.href, location.href); return u.host !== location.host && TICKET_HOSTS.test(u.host); } catch (e) { return false; }
  }
  function goTo(href) {
    var w = window.open(href, '_blank');
    if (w) { try { w.opener = null; } catch (e) { /* cross-origin */ } } else location.href = href;
  }
  function phoneOk(v) {
    var p = String(v || '').replace(/[\s()-]/g, '');
    if (/^\+?263/.test(p)) p = '0' + p.replace(/^\+?263/, '');
    return /^07\d{8}$/.test(p) || /^\+\d{8,15}$/.test(p);
  }
  var tkOpen = false;
  function openTicketStep(href) {
    if (tkOpen) return;
    tkOpen = true;
    var host = '';
    try { host = new URL(href).host.replace(/^www\./, ''); } catch (e) { /* keep empty */ }
    var siteLabel = /megaticket/i.test(host) ? 'Megaticket' : host || 'the ticket site';
    var msg = el('p', { class: 'upd-msg', role: 'status' });
    function field(label, input, hint) {
      return el('label', { class: 'tk-field' }, [el('span', { class: 'tk-label' }, [label, hint ? el('small', { text: hint }) : null]), input]);
    }
    var name = el('input', { type: 'text', name: 'name', maxlength: '80', autocomplete: 'name', required: true, placeholder: 'e.g. Tariro Moyo' });
    var phone = el('input', { type: 'tel', name: 'phone', autocomplete: 'tel', required: true, placeholder: '0771 234 567' });
    var email = el('input', { type: 'email', name: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'upd-trap', 'aria-hidden': 'true' });
    var news = el('input', { type: 'checkbox', name: 'news' });
    var send = el('button', { type: 'submit', class: 'btn btn-primary btn-block tk-go', text: 'Continue to tickets →' });
    var bg = el('div', { class: 'tk-bg' });
    function close() {
      wrapEl.classList.remove('show');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
      setTimeout(function () { wrapEl.remove(); tkOpen = false; }, 220);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    var form = el('form', { class: 'upd-form tk-form', novalidate: true }, [
      field('Your name', name),
      field('WhatsApp number', phone),
      field('Email', email, 'optional'),
      trap,
      el('label', { class: 'upd-consent tk-news' }, [news, el('span', { text: 'Also send me news about future events, ticket drops and merch. I can ask you to stop at any time.' })]),
      msg, send,
      el('p', { class: 'tk-small' }, ['You’ll finish buying on ' + siteLabel + '. We use your details as our ', el('a', { href: '/privacy', target: '_blank', text: 'Privacy Policy' }), ' explains.'])
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';
      if (!name.value.trim()) { msg.textContent = 'Please add your name.'; name.focus(); return; }
      if (!phoneOk(phone.value)) { msg.textContent = 'Please type a valid WhatsApp number, e.g. 0771 234 567.'; phone.focus(); return; }
      if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { msg.textContent = 'Please check your email address, or leave it empty.'; email.focus(); return; }
      var body = { name: name.value, phone: phone.value, email: email.value, website: trap.value, consent: news.checked, source: 'tickets', page: location.pathname };
      // Saved in the background; the buyer never waits for it and is never stopped by it.
      try { fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(function () {}); } catch (err) { /* old browser */ }
      try { localStorage.setItem(TK_KEY, JSON.stringify({ name: name.value.trim(), at: Date.now() })); } catch (err) { /* private mode */ }
      if (news.checked) setUpd({ done: Date.now() });
      close();
      goTo(href);
    });
    var box = el('div', { class: 'tk-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tkTitle' }, [
      el('button', { type: 'button', class: 'upd-x', 'aria-label': 'Close', text: '×', onclick: close }),
      el('div', { class: 'tk-eq', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i'), el('i'), el('i')]),
      el('p', { class: 'upd-kicker', text: 'One quick step' }),
      el('h3', { id: 'tkTitle', class: 'display', text: 'Before your tickets' }),
      el('p', { class: 'upd-sub', text: 'Tell us who’s coming, so we can send entry details and any changes to the event to your WhatsApp. You’ll only be asked once on this phone.' }),
      form
    ]);
    var wrapEl = el('div', { class: 'tk-wrap' }, [bg, box]);
    bg.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrapEl);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { wrapEl.classList.add('show'); });
    setTimeout(function () { name.focus({ preventScroll: true }); }, 60);
  }
  if (!EDIT && !/^\/admin/.test(location.pathname)) {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!isTicketLink(a) || tkSaved()) return;
      e.preventDefault();
      openTicketStep(a.href);
    });
  }

  window.RNB = {
    t: t, el: el, api: api, mediaUrl: mediaUrl, fmtLong: fmtLong, fmtDay: fmtDay, fmtMonth: fmtMonth,
    safeLink: safeLink, eventCard: eventCard, flyerStrip: flyerStrip, eventButtons: eventButtons, galleryItem: galleryItem, merchCard: merchCard, money: mcMoney, renderFooter: renderFooter, openUpdates: openUpdates
  };

  renderHeader();
  renderFooter(null);
  if (!document.body.hasAttribute('data-no-settings')) {
    api('/api/settings').then(renderFooter).catch(function () { /* keep defaults */ });
  }
})();

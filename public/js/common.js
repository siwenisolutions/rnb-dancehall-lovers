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
    ticket1_label: 'Get Tickets', ticket1_url: '',
    ticket2_label: '', ticket2_url: ''
  };

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
    return '/media/' + encodeURIComponent(id) + (thumb ? '?size=thumb' : '');
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
    var links = [['/#upcoming', 'Upcoming'], ['/events', 'Events'], ['/gallery', 'Gallery'], ['/#experience', 'Experiences']];
    var nav = el('nav', { class: 'nav-links', id: 'navLinks' }, links.map(function (l) {
      return el('a', { href: l[0], text: l[1] });
    }));
    var burger = el('button', { class: 'burger', id: 'burgerBtn', 'aria-label': 'Toggle menu', 'aria-expanded': 'false' },
      [el('span'), el('span'), el('span')]);
    header.appendChild(el('div', { class: 'nav' }, [
      el('a', { class: 'logo', href: '/' }, [el('img', { src: '/img/logo.png', alt: 'RNB Dancehall Lovers', width: '60', height: '49' })]),
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

  // ---------- footer ----------
  function renderFooter(s) {
    var footer = document.querySelector('footer[data-site]');
    if (!footer) return;
    s = Object.assign({}, DEFAULTS, s || {});
    footer.textContent = '';

    var socials = [['instagram_url', 'ig'], ['facebook_url', 'f'], ['tiktok_url', 'tt'], ['youtube_url', 'yt']]
      .filter(function (x) { return safeLink(s[x[0]]); })
      .map(function (x) {
        return el('a', { href: safeLink(s[x[0]]), target: '_blank', rel: 'noopener', 'aria-label': x[0].replace('_url', ''), text: x[1] });
      });

    var tel = s.phone ? '+263' + s.phone.replace(/\D/g, '').replace(/^(263|0)/, '') : '';
    var contact = [el('h4', { text: 'Contact' })];
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
    [['ticket1_label', 'ticket1_url'], ['ticket2_label', 'ticket2_url']].forEach(function (t) {
      var url = safeLink(s[t[1]]);
      if (url) buttons.push(el('a', { class: 'btn btn-outline', href: url, target: '_blank', rel: 'noopener', text: (s[t[0]] || 'Get Tickets') + ' →' }));
    });
    contact.push(el('div', { class: 'footer-buttons', style: 'margin-top:14px;' }, buttons));

    footer.appendChild(el('div', { class: 'wrap' }, [
      el('div', { class: 'footer-grid' }, [
        el('div', { class: 'footer-col footer-brand' }, [
          el('div', { class: 'logo' }, [el('img', { src: '/img/logo.png', alt: 'RNB Dancehall Lovers', style: 'width:60px;' })]),
          el('div', { class: 'footer-socials' }, socials),
          el('p', { text: 'RNB Dancehall Lovers' + (s.address ? ' · ' + s.address : '') })
        ]),
        el('div', { class: 'footer-col' }, [
          el('h4', { text: 'Events' }),
          el('a', { href: '/events#upcoming', text: 'Upcoming Events' }),
          el('a', { href: '/events#past', text: 'Past Events' }),
          el('a', { href: '/gallery', text: 'Photo Gallery' }),
          el('a', { href: '/gallery?category=experience', text: 'The Experience' })
        ]),
        el('div', { class: 'footer-col' }, [
          el('h4', { text: 'Visit' }),
          el('a', { href: 'https://maps.google.com/?q=' + encodeURIComponent(s.address || ''), target: '_blank', rel: 'noopener', text: s.address || 'Harare, Zimbabwe' })
        ]),
        el('div', { class: 'footer-col' }, contact)
      ]),
      el('div', { class: 'footer-bottom' }, [
        el('span', { text: '© ' + new Date().getFullYear() + ' RNB Dancehall Lovers · Harare, Zimbabwe' })
      ])
    ]));
  }

  // ---------- event card ----------
  function eventCard(ev) {
    var poster = ev.cover_media_id
      ? el('div', { class: 'poster ph media', style: "background-image:url('" + mediaUrl(ev.cover_media_id, true) + "')", role: 'img', 'aria-label': ev.title })
      : el('div', { class: 'poster empty' }, [el('span', { text: ev.title })]);
    poster.appendChild(el('div', { class: 'date-badge' }, [el('b', { text: fmtDay(ev.starts_at) }), el('small', { text: fmtMonth(ev.starts_at) })]));
    var actions = [el('a', { class: 'btn btn-outline', href: '/events/' + ev.id, text: 'Details' })];
    var ticket = safeLink(ev.ticket_url);
    if (ticket) actions.unshift(el('a', { class: 'btn btn-primary', href: ticket, target: '_blank', rel: 'noopener', text: 'Get Tickets' }));
    return el('article', { class: 'event-card' }, [
      el('a', { href: '/events/' + ev.id, 'aria-label': ev.title }, [poster]),
      el('div', { class: 'body' }, [
        el('h3', { text: ev.title }),
        el('div', { class: 'when', text: fmtLong(ev.starts_at) }),
        ev.venue ? el('div', { class: 'when', text: ev.venue }) : null,
        el('div', { class: 'actions' }, actions)
      ])
    ]);
  }

  // ---------- lightbox ----------
  var lb, lbImg, lbCap, lbItems = [], lbIndex = 0;
  function ensureLightbox() {
    if (lb) return;
    lbImg = el('img', { alt: '' });
    lbCap = el('figcaption');
    lb = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer' }, [
      el('figure', null, [lbImg, lbCap]),
      el('button', { class: 'lb-close', 'aria-label': 'Close', text: '×', onclick: closeLightbox }),
      el('button', { class: 'lb-prev', 'aria-label': 'Previous photo', text: '‹', onclick: function () { showLightbox(lbIndex - 1); } }),
      el('button', { class: 'lb-next', 'aria-label': 'Next photo', text: '›', onclick: function () { showLightbox(lbIndex + 1); } })
    ]);
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') showLightbox(lbIndex - 1);
      if (e.key === 'ArrowRight') showLightbox(lbIndex + 1);
    });
    document.body.appendChild(lb);
  }
  function showLightbox(i) {
    if (!lbItems.length) return;
    lbIndex = (i + lbItems.length) % lbItems.length;
    var p = lbItems[lbIndex];
    lbImg.src = mediaUrl(p.id);
    lbImg.alt = p.caption || 'RNB Dancehall Lovers photo';
    lbCap.textContent = [p.caption, p.event_title].filter(Boolean).join(' · ');
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
    el: el, api: api, mediaUrl: mediaUrl, fmtLong: fmtLong, fmtDay: fmtDay, fmtMonth: fmtMonth,
    safeLink: safeLink, eventCard: eventCard, galleryItem: galleryItem, renderFooter: renderFooter
  };

  renderHeader();
  renderFooter(null);
  if (!document.body.hasAttribute('data-no-settings')) {
    api('/api/settings').then(renderFooter).catch(function () { /* keep defaults */ });
  }
})();

(function () {
  'use strict';

  var TZ = 'Africa/Harare';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // ---------- helpers ----------
  // Text always goes in via textContent, so nothing typed in the panel can run as code.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // ---------- photos are made smaller here, before uploading ----------
  // The website runs on Cloudflare's free plan, which has no time for image
  // work, so the phone or computer does it: a large copy (1600 px) and a
  // thumbnail (640 px), as WebP (JPEG on browsers that can't make WebP).
  // This also turns phone photos the right way up and drops their GPS data.
  // Each photo's thumbnail goes in a second field, "<field>_thumb", in the
  // same order (empty when a file couldn't be shrunk, such as a video).
  var SHRINK = { full: 1600, fullQ: 0.8, thumb: 640, thumbQ: 0.72 };
  function drawTo(bitmap, max, quality) {
    var scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * scale));
    c.height = Math.max(1, Math.round(bitmap.height * scale));
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, c.width, c.height);
    function blob(type) { return new Promise(function (ok) { c.toBlob(ok, type, quality); }); }
    return blob('image/webp').then(function (b) {
      return b && b.type === 'image/webp' ? b : blob('image/jpeg');
    });
  }
  function shrinkPhoto(file) {
    if (!(file instanceof Blob) || !/^image\/(jpeg|png|webp|heic|heif|avif|bmp)$/i.test(file.type || '') || !window.createImageBitmap) return Promise.resolve(null);
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      return drawTo(bmp, SHRINK.full, SHRINK.fullQ).then(function (full) {
        return drawTo(bmp, SHRINK.thumb, SHRINK.thumbQ).then(function (thumb) {
          if (bmp.close) bmp.close();
          return full && thumb ? { full: full, thumb: thumb } : null;
        });
      });
    }).catch(function () { return null; });
  }
  function shrinkForm(fd) {
    var entries = [];
    fd.forEach(function (v, k) { entries.push([k, v]); });
    if (!entries.some(function (e) { return e[1] instanceof Blob; })) return Promise.resolve(fd);
    var out = new FormData();
    var thumbs = [];
    return entries.reduce(function (p, e) {
      return p.then(function () {
        var k = e[0], v = e[1];
        if (!(v instanceof Blob)) { out.append(k, v); return; }
        return shrinkPhoto(v).then(function (s) {
          var base = (v.name || 'photo').replace(/\.[^.]+$/, '');
          if (s) {
            var ext = s.full.type === 'image/webp' ? '.webp' : '.jpg';
            out.append(k, s.full, base + ext);
            thumbs.push([k + '_thumb', s.thumb, base + '-thumb' + ext]);
          } else {
            out.append(k, v, v.name || 'file');
            thumbs.push([k + '_thumb', new Blob([]), 'none']);
          }
        });
      });
    }, Promise.resolve()).then(function () {
      thumbs.forEach(function (t) { out.append(t[0], t[1], t[2]); });
      return out;
    });
  }

  // Every admin request goes through here. The server requires the X-RNB-Admin
  // header on changes (blocks cross-site requests).
  function call(method, url, body) {
    if (body instanceof FormData) {
      return shrinkForm(body).then(function (fd) { return send(method, url, fd); });
    }
    return send(method, url, body);
  }
  function send(method, url, body) {
    var opts = { method: method, headers: { 'X-RNB-Admin': '1', Accept: 'application/json' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && url !== '/api/admin/login') showLogin();
        if (r.status === 403 && data.code === 'must_change') showSetPassword(false);
        if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
        return data;
      });
    }, function () { throw new Error('No connection. Check your internet and try again.'); });
  }
  function get(url) { return call('GET', url); }

  function say(box, text, ok) {
    box.hidden = false;
    box.className = 'msg ' + (ok ? 'ok' : 'err');
    box.textContent = text;
    if (ok) setTimeout(function () { if (box.textContent === text) box.hidden = true; }, 5000);
  }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }

  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Saving…'; btn.disabled = true; }
    else { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; }
  }

  function parts(iso) {
    var out = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(iso ? new Date(iso) : new Date()).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }
  function fmtDate(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
  function fmtTime(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  }
  function fmtLong(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)) + ' · ' + fmtTime(iso);
  }
  // ISO -> "YYYY-MM-DDTHH:MM" in Zimbabwe time for the date picker.
  function toLocalInput(iso) {
    var p = parts(iso);
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  }
  function media(id, thumb) { return '/media/' + id + (thumb ? '?size=thumb' : ''); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function catLabel(c) { return c === 'experience' ? 'Experience' : c === 'event' ? 'Event' : 'Highlight'; }

  // ---------- login ----------
  // Login background: the website's header video (or its first header photo).
  var loginBgDone = false;
  function loadLoginBg() {
    if (loginBgDone) return;
    loginBgDone = true;
    var bg = $('loginBg');
    fetch('/api/home').then(function (r) { return r.json(); }).then(function (d) {
      var hero = (d.slots && d.slots.hero) || [];
      var video = hero.filter(function (i) { return /^video\//.test(i.mime); })[0];
      var photo = hero.filter(function (i) { return /^image\//.test(i.mime); })[0];
      if (video && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        var v = el('video', { src: media(video.id), autoplay: true, loop: true, playsinline: true, preload: 'auto' });
        v.muted = true;
        bg.appendChild(v);
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } else if (photo) {
        bg.style.backgroundImage = "url('" + media(photo.id) + "')";
      }
    }).catch(function () { /* keep the built-in photo */ });
  }

  var me = { email: '', name: '' };
  var lastPassword = ''; // kept in memory only, for the "choose your password" step right after logging in
  function showLogin() {
    loadLoginBg();
    $('appView').hidden = true;
    $('setPwView').hidden = true;
    $('loginView').hidden = false;
    setTimeout(function () { ($('loginEmail').value ? $('password') : $('loginEmail')).focus(); }, 50);
  }
  function showSetPassword(knowCurrent) {
    $('appView').hidden = true;
    $('loginView').hidden = true;
    $('setPwView').hidden = false;
    // Temporary logins also set their own email and name here.
    $('setPwOwnBox').hidden = !me.temporary;
    $('setPwEmail').required = !!me.temporary;
    $('setPwEmail').value = me.temporary ? '' : me.email;
    $('setPwName').value = me.name && !/^Temporary login/i.test(me.name) ? me.name : '';
    $('setPwIntro').textContent = me.temporary
      ? 'This is a temporary login and stops working 24 hours after it was made. Add your own email and choose your own password to keep using the admin panel.'
      : 'You logged in with a temporary password. Choose your own now. Only you will know it.';
    $('setPwCurrentBox').hidden = !!(knowCurrent && lastPassword);
    setTimeout(function () { ($('setPwCurrentBox').hidden ? $('setPwNew') : $('setPwCurrent')).focus(); }, 50);
  }
  function setMe(s) {
    me = { email: s.email || '', name: s.name || '', temporary: !!s.temporary };
    $('profileEmail').textContent = me.email || 'Admin';
  }
  function showApp() {
    $('loginView').hidden = true;
    $('setPwView').hidden = true;
    $('appView').hidden = false;
    loadAll();
    checkOrders();
    if (!welcomeHidden()) openWelcome();
  }

  // ---------- welcome video ----------
  // Opens every time the admin panel is opened, until someone ticks
  // "Don't show this automatically" on that device. A new person on another
  // device still sees it. Always available from the Help button.
  var WELCOME_KEY = 'rnbWelcomeHidden';
  function welcomeHidden() {
    try { return localStorage.getItem(WELCOME_KEY) === '1'; } catch (e) { return false; }
  }
  function openWelcome() {
    closeMenu();
    $('welcomeHide').checked = welcomeHidden();
    $('welcomeModal').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { $('welcomeDone').focus(); }, 50);
  }
  function closeWelcome() {
    try {
      if ($('welcomeHide').checked) localStorage.setItem(WELCOME_KEY, '1');
      else localStorage.removeItem(WELCOME_KEY);
    } catch (e) { /* private mode: just close */ }
    $('welcomeVideo').pause();
    $('welcomeModal').hidden = true;
    document.body.style.overflow = '';
  }
  $('helpBtn').addEventListener('click', openWelcome);
  $$('[data-action="welcome-video"]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); openWelcome(); }); });
  $('welcomeClose').addEventListener('click', closeWelcome);
  $('welcomeDone').addEventListener('click', closeWelcome);
  $('welcomeModal').addEventListener('click', function (e) { if (e.target === $('welcomeModal')) closeWelcome(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('welcomeModal').hidden) closeWelcome(); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button');
    busy(btn, true, 'Logging in…');
    var pw = $('password').value;
    call('POST', '/api/admin/login', { email: $('loginEmail').value, password: pw, remember: $('loginRemember').checked }).then(function (r) {
      $('password').value = '';
      $('loginMsg').hidden = true;
      setMe(r);
      try { localStorage.setItem('rnbLoginEmail', me.email); } catch (e2) { /* ignore */ }
      if (r.mustChange) { lastPassword = pw; showSetPassword(true); } else showApp();
    }).catch(function (err) { say($('loginMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });

  $('logoutBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    call('POST', '/api/admin/logout').then(showLogin, showLogin);
  });

  // ---------- menus (profile + table rows) ----------
  var openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.hidden = true;
    openMenu.trigger.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }
  function toggleMenu(trigger, menu) {
    var same = openMenu && openMenu.menu === menu;
    closeMenu();
    if (same) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { trigger: trigger, menu: menu };
  }
  document.addEventListener('click', function (e) {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.trigger.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMenu(); closeDrawers(); }
  });
  $('profileBtn').addEventListener('click', function (e) {
    if ($('profileMenu').contains(e.target)) return;
    toggleMenu($('profileBtn'), $('profileMenu'));
  });
  $('profileBtn').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMenu($('profileBtn'), $('profileMenu')); }
  });

  // ---------- tabs ----------
  var loadedPhotos = false;
  function goTo(name) {
    closeMenu();
    if (name === 'text') loadText();
    if (name === 'events') loadMegaticket();
    if (name === 'shop') loadShop();
    if (name === 'account') loadAccount();
    $$('[data-tab]').forEach(function (t) { t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'); });
    $$('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (name === 'photos' && !loadedPhotos) { loadedPhotos = true; loadPhotos(true); }
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    window.scrollTo(0, 0);
  }
  $$('[data-tab]').forEach(function (t) { t.addEventListener('click', function () { goTo(t.dataset.tab); }); });
  $$('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { goTo(b.dataset.goto); }); });
  $$('[data-action="new-event"]').forEach(function (b) { b.addEventListener('click', function () { openEventForm(null); }); });
  $$('[data-action="upload-photos"]').forEach(function (b) {
    b.addEventListener('click', function () { goTo('photos'); setTimeout(function () { $('upTarget').focus(); }, 100); });
  });
  $('refreshBtn').addEventListener('click', function () { loadAll().then(function () { toast('Up to date'); }); });

  // ---------- data ----------
  var events = [];
  var settings = {};

  // ---------- visitors ----------
  var PAGE_NAMES = { '/': 'Home page', '/events': 'Events', '/gallery': 'Gallery', other: 'Other pages' };
  function n(x) { return Number(x || 0).toLocaleString('en-GB'); }
  function loadVisits() {
    get('/api/admin/visits').then(function (v) {
      $('vNow').textContent = '● ' + n(v.now) + ' on the site now';
      [['vToday', 'vTodayViews', v.today], ['vYesterday', 'vYesterdayViews', v.yesterday], ['v7', 'v7Views', v.last7], ['v30', 'v30Views', v.last30]].forEach(function (r) {
        $(r[0]).textContent = n(r[2].visitors);
        $(r[1]).textContent = n(r[2].views) + ' page views';
      });
      var max = Math.max.apply(null, v.daily.map(function (d) { return d.visitors; }).concat([1]));
      var chart = $('visitChart');
      chart.textContent = '';
      v.daily.forEach(function (d, i) {
        var label = fmtDate(d.day);
        var bar = el('div', { class: 'bar' + (i === v.daily.length - 1 ? ' today' : ''), style: 'height:' + Math.max(1.5, d.visitors / max * 100) + '%', title: label + ': ' + n(d.visitors) + ' visitors, ' + n(d.views) + ' page views' });
        if (i % 5 === 4 || i === v.daily.length - 1) bar.appendChild(el('i', { text: i === v.daily.length - 1 ? 'Today' : label.replace(/\s\d{4}$/, '') }));
        chart.appendChild(bar);
      });
      function list(box, rows, name, key) {
        box.textContent = '';
        if (!rows.length) { box.appendChild(el('li', null, [el('span', { class: 'muted', text: 'No visits yet' })])); return; }
        rows.forEach(function (r) { box.appendChild(el('li', null, [el('span', { text: name(r) }), el('b', { text: n(r[key]) })])); });
      }
      var titles = {};
      events.forEach(function (e) { titles['/events/' + e.id] = e.title; });
      list($('visitPages'), v.pages, function (r) { return PAGE_NAMES[r.path] || titles[r.path] || r.path; }, 'views');
      list($('visitSources'), v.sources, function (r) { return r.source; }, 'visits');
      if (v.total && v.total.since) $('visitsNote').textContent = 'People who opened your website since ' + fmtDate(v.total.since) + '. Counted without cookies; you, logged in here, aren\'t counted.';
    }).catch(function () { /* the card stays as it is */ });
  }
  setInterval(function () { if (!$('appView').hidden && !document.querySelector('[data-panel="overview"]').hidden) loadVisits(); }, 60000);

  function loadAll() {
    loadVisits();
    return Promise.all([
      get('/api/events'),
      get('/api/admin/stats'),
      get('/api/settings'),
      get('/api/photos?limit=6'),
      get('/api/admin/slots')
    ]).then(function (r) {
      events = r[0].upcoming.map(function (e) { e.up = true; return e; }).concat(r[0].past);
      settings = r[2];
      slotData = r[4];
      renderOverview(r[1], r[3].photos);
      renderStorage(r[1]);
      renderTable();
      renderEventGrid();
      fillSettings();
      renderSlots();
      fillTargets();
    }).catch(function (err) { toast(err.message); });
  }

  // ---------- overview ----------
  function renderOverview(stats, latest) {
    var hour = Number(parts().hour);
    $('greeting').textContent = (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') + ', RNB team';
    if (me.name) $('greeting').textContent = $('greeting').textContent.replace('RNB team', me.name.split(' ')[0]);

    // next event
    var next = events.filter(function (e) { return e.up; })[0];
    if (next) {
      var days = Math.round((new Date(next.starts_at) - Date.now()) / 86400000);
      $('nextChip').textContent = days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : 'In ' + days + ' days';
      $('nextTitle').textContent = next.title;
      $('nextMeta').textContent = fmtLong(next.starts_at) + (next.venue ? ' · ' + next.venue : '');
    } else {
      $('nextChip').textContent = 'None yet';
      $('nextTitle').textContent = 'No upcoming events';
      $('nextMeta').textContent = 'Add your next night so fans can find it on the home page.';
    }

    $('photoTotal').textContent = plural(stats.photos, 'photo');
    $('mExperience').textContent = stats.site_photos;
    $('mEvent').textContent = stats.event_photos;
    $('m30').textContent = stats.photos_30d;

    $('sUpcoming').textContent = stats.upcoming;
    $('sPast').textContent = stats.past;
    $('sPhotos').textContent = stats.photos;
    $('s30Trend').textContent = '+' + stats.photos_30d;
    var mb = stats.db_bytes / 1048576;
    var limitMb = stats.storage_limit_bytes / 1048576;
    var pct = Math.min(100, (stats.db_bytes / stats.storage_limit_bytes) * 100);
    $('sStorage').textContent = (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    $('storageBar').style.width = Math.max(pct, 2) + '%';
    $('storageBar').style.background = pct > 85 ? 'var(--red)' : 'var(--purple)';
    $('storageFoot').textContent = Math.round(pct) + '% of ' + fmtMb(stats.storage_limit_bytes) + ' · ' + fmtMb(Math.max(0, stats.storage_limit_bytes - stats.db_bytes)) + ' free';

    renderChart();

    var box = $('latestPhotos');
    box.textContent = '';
    if (!latest.length) box.appendChild(el('p', { class: 'empty', text: 'No photos yet.' }));
    latest.forEach(function (p) {
      box.appendChild(el('a', { href: media(p.id), target: '_blank', rel: 'noopener', style: "background-image:url('" + media(p.id, true) + "')", 'aria-label': 'Open photo' }, [
        el('span', { text: p.slot ? slotLabel(p.slot) : catLabel(p.category) })
      ]));
    });

    var facts = $('facts');
    facts.textContent = '';
    [['Email', settings.contact_email], ['Phone', settings.phone], ['Address', settings.address], ['Instagram', (settings.instagram_url || '').replace(/^https?:\/\/(www\.)?/, '')]]
      .forEach(function (f) {
        facts.appendChild(el('dt', { text: f[0] }));
        facts.appendChild(el('dd', { text: f[1] || '—' }));
      });
  }

  function renderChart() {
    var now = parts();
    var year = now.year;
    var counts = MONTHS.map(function () { return { up: 0, past: 0 }; });
    events.forEach(function (e) {
      var p = parts(e.starts_at);
      if (p.year !== year) return;
      counts[Number(p.month) - 1][e.up ? 'up' : 'past'] += 1;
    });
    var max = Math.max.apply(null, counts.map(function (c) { return c.up + c.past; }).concat([1]));
    var top = max <= 4 ? 4 : Math.ceil(max / 4) * 4;

    var chart = $('chart');
    chart.textContent = '';
    var y = el('div', { class: 'chart-y' });
    [top, top * 0.75, top * 0.5, top * 0.25, 0].forEach(function (v) { y.appendChild(el('span', { text: String(Math.round(v * 10) / 10) })); });
    var plot = el('div', { class: 'chart-plot' });
    counts.forEach(function (c, i) {
      var stack = el('div', { class: 'bar-stack' });
      if (c.up) stack.appendChild(el('div', { class: 'bar bar-up', style: 'height:' + (c.up / top * 100) + '%' }));
      if (c.past) stack.appendChild(el('div', { class: 'bar bar-past', style: 'height:' + (c.past / top * 100) + '%' }));
      if (!c.up && !c.past) stack.appendChild(el('div', { class: 'bar-empty' }));
      var title = MONTHS[i] + ': ' + plural(c.up, 'upcoming event') + ', ' + plural(c.past, 'past event');
      plot.appendChild(el('div', { class: 'bar-col' + (i === Number(now.month) - 1 ? ' now' : ''), title: title }, [stack, el('small', { text: MONTHS[i] })]));
    });
    chart.appendChild(y);
    chart.appendChild(plot);
  }

  // ---------- shared event actions ----------
  function eventMenu(ev) {
    var trigger = el('button', { class: 'dots', type: 'button', 'aria-label': 'More options for ' + ev.title, 'aria-haspopup': 'true', 'aria-expanded': 'false', text: '•••' });
    var menu = el('div', { class: 'menu', hidden: true }, [
      el('button', { type: 'button', text: 'Edit event', onclick: function () { closeMenu(); openEventForm(ev); } }),
      el('button', { type: 'button', text: 'Add or manage photos', onclick: function () { closeMenu(); openEventPhotos(ev); } }),
      el('a', { href: '/events/' + ev.id, target: '_blank', rel: 'noopener', text: 'See it on the website' }),
      el('button', { type: 'button', text: 'Delete event', style: 'color:var(--red)', onclick: function () { closeMenu(); deleteEvent(ev); } })
    ]);
    trigger.addEventListener('click', function () { toggleMenu(trigger, menu); });
    return el('div', { class: 'row-menu' }, [trigger, menu]);
  }

  function emptyEvents(text, withButton) {
    return el('div', { class: 'empty-block' }, [
      el('span', { class: 'empty-ic' }, [svgIcon('M3 5h18v16H3zM16 3v4M8 3v4M3 10h18')]),
      el('b', { text: text }),
      withButton ? el('span', { class: 'muted', text: 'Add your next night so fans can find it on the website.' }) : null,
      withButton ? el('button', { class: 'btn btn-dark', type: 'button', text: '+ Add your first event', onclick: function () { openEventForm(null); } }) : null
    ]);
  }

  function svgIcon(d) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }

  function matches(e, q, f) {
    if (f === 'up' && !e.up) return false;
    if (f === 'past' && e.up) return false;
    if (q && (e.title + ' ' + e.venue).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  // ---------- overview table ----------
  var overviewState = { q: '', f: '' };
  $$('[data-search="overview"]').forEach(function (input) {
    input.addEventListener('input', function () { overviewState.q = input.value.trim().toLowerCase(); renderTable(); });
  });
  $$('[data-filter="overview"]').forEach(function (sel) {
    sel.addEventListener('change', function () { overviewState.f = sel.value; renderTable(); });
  });

  function renderTable() {
    var table = document.querySelector('[data-table="overview"]');
    var wrap = table.parentNode;
    var rows = events.filter(function (e) { return matches(e, overviewState.q, overviewState.f); }).slice(0, 6);
    var old = wrap.parentNode.querySelector('.empty-block');
    if (old) old.remove();
    table.textContent = '';
    if (!rows.length) {
      wrap.hidden = true;
      wrap.parentNode.appendChild(events.length ? emptyEvents('No events match your search.', false) : emptyEvents('No events yet', true));
      return;
    }
    wrap.hidden = false;
    table.appendChild(el('thead', null, [el('tr', null, ['Event', 'Date', 'Venue', 'Photos', 'Status', ''].map(function (h) {
      return el('th', { text: h, scope: 'col' });
    }))]));
    var tbody = el('tbody');
    rows.forEach(function (ev) {
      tbody.appendChild(el('tr', null, [
        el('td', null, [el('div', { class: 'ev-cell' }, [
          el('span', { class: 'ev-thumb', style: ev.cover_media_id ? "background-image:url('" + media(ev.cover_media_id, true) + "')" : '' }),
          el('span', null, [el('b', { text: ev.title }), el('small', null, [ev.ticket_url ? 'Tickets on sale' : 'No ticket page yet', ev.megaticket_slug ? el('span', { class: 'tag-mt', text: 'From Megaticket' }) : null])])
        ])]),
        el('td', null, [el('span', { text: fmtDate(ev.starts_at) }), el('br'), el('small', { class: 'muted', text: fmtTime(ev.starts_at) })]),
        el('td', { text: ev.venue || '—' }),
        el('td', null, [el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: String(ev.photo_count), title: 'Add or manage photos', onclick: function () { openEventPhotos(ev); } })]),
        el('td', null, [el('span', { class: 'status ' + (ev.up ? 'up' : 'past'), text: ev.up ? 'Upcoming' : 'Past' })]),
        el('td', { style: 'text-align:right' }, [eventMenu(ev)])
      ]));
    });
    table.appendChild(tbody);
  }

  // ---------- events page: grid of event cards ----------
  var eventsState = { q: '', f: '' };
  $('eventSearch').addEventListener('input', function () { eventsState.q = this.value.trim().toLowerCase(); renderEventGrid(); });

  function renderEventGrid() {
    var grid = $('eventGrid');
    grid.textContent = '';
    var list = events.filter(function (e) { return matches(e, eventsState.q, eventsState.f); });
    if (!list.length) {
      grid.appendChild(events.length ? emptyEvents('No events match.', false) : emptyEvents('No events yet', true));
      return;
    }
    list.forEach(function (ev) {
      var editing = $('evId').value === String(ev.id);
      grid.appendChild(el('article', { class: 'ev-card' + (editing ? ' editing' : '') }, [
        el('div', { class: 'ev-poster', style: ev.cover_media_id ? "background-image:url('" + media(ev.cover_media_id, true) + "')" : '' }, [
          el('span', { class: 'ev-date' }, [el('b', { text: parts(ev.starts_at).day }), el('small', { text: MONTHS[Number(parts(ev.starts_at).month) - 1] })]),
          el('span', { class: 'ev-status ' + (ev.up ? 'up' : 'past'), text: ev.up ? 'Upcoming' : 'Past' }),
          ev.cover_media_id ? null : el('span', { class: 'ev-noposter', text: ev.title })
        ]),
        el('div', { class: 'ev-body' }, [
          el('div', { class: 'card-row' }, [el('b', { class: 'ev-title', text: ev.title }), eventMenu(ev)]),
          el('small', { class: 'muted', text: fmtLong(ev.starts_at) }),
          ev.venue ? el('small', { class: 'muted', text: ev.venue }) : null,
          el('div', { class: 'ev-actions' }, [
            el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Edit', onclick: function () { openEventForm(ev); } }),
            el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Photos (' + ev.photo_count + ')', onclick: function () { openEventPhotos(ev); } })
          ])
        ])
      ]));
    });
  }

  function deleteEvent(ev) {
    if (!confirm('Delete "' + ev.title + '" and all of its photos? This cannot be undone.')) return;
    call('DELETE', '/api/admin/events/' + ev.id).then(function () {
      toast('Event deleted');
      if (currentEvent && currentEvent.id === ev.id) closeDrawers();
      if ($('evId').value === String(ev.id)) resetEventForm();
      loadAll();
    }).catch(function (err) { alert(err.message); });
  }

  // ---------- drawer (event photos) ----------
  var lastFocus = null;
  function openDrawer(id) {
    closeMenu();
    lastFocus = document.activeElement;
    $('drawerBackdrop').hidden = false;
    var d = $(id);
    d.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function () { d.classList.add('open'); });
    document.body.style.overflow = 'hidden';
  }
  function closeDrawers() {
    $$('.drawer.open').forEach(function (d) { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); });
    $('drawerBackdrop').hidden = true;
    document.body.style.overflow = '';
    currentEvent = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('drawerBackdrop').addEventListener('click', closeDrawers);
  $$('[data-close]').forEach(function (b) { b.addEventListener('click', closeDrawers); });

  // ---------- add / edit event (left-hand form on the Events page) ----------
  function resetEventForm() {
    $('eventForm').reset();
    $('evMsg').hidden = true;
    $('evId').value = '';
    $('eventFormTitle').textContent = 'Add an event';
    $('evSubmit').textContent = 'Add event';
    $('evCancel').hidden = true;
    $('evPosterName').textContent = 'Choose';
    $('posterPreview').style.backgroundImage = '';
    flyerState = { tickets: null, tables: null };
    $$('.flyer-pick[data-flyer]').forEach(function (box) { showFlyer(box, null); });
    renderEventGrid();
  }
  // Tickets and tables flyers: id of the saved one, and what to do on save.
  var flyerState = { tickets: null, tables: null }, flyerRemove = {};
  function showFlyer(box, src, name) {
    box.querySelector('.poster-preview').style.backgroundImage = src ? "url('" + src + "')" : '';
    box.querySelector('small').textContent = name || (src ? 'Change' : 'Choose');
    box.querySelector('.flyer-x').hidden = !src;
  }
  $$('.flyer-pick[data-flyer]').forEach(function (box) {
    var kind = box.dataset.flyer, input = box.querySelector('input');
    input.addEventListener('change', function () {
      var f = input.files[0];
      if (!f) return;
      flyerRemove[kind] = false;
      showFlyer(box, URL.createObjectURL(f), f.name);
    });
    box.querySelector('.flyer-x').addEventListener('click', function (e) {
      e.preventDefault();
      input.value = '';
      flyerRemove[kind] = !!flyerState[kind];
      showFlyer(box, null);
    });
  });
  $('evCancel').addEventListener('click', resetEventForm);

  function openEventForm(ev) {
    goTo('events');
    resetEventForm();
    if (ev) {
      $('evId').value = ev.id;
      $('eventFormTitle').textContent = 'Edit event';
      $('evSubmit').textContent = 'Save changes';
      $('evCancel').hidden = false;
      $('evTitle').value = ev.title;
      $('evStart').value = toLocalInput(ev.starts_at);
      $('evVenue').value = ev.venue;
      $('evTicket').value = ev.ticket_url;
      $('evTables').value = ev.tables_url || '';
      $('evDesc').value = ev.description;
      if (ev.cover_media_id) {
        $('evPosterName').textContent = 'Change';
        $('posterPreview').style.backgroundImage = "url('" + media(ev.cover_media_id, true) + "')";
      }
      flyerState = { tickets: ev.tickets_flyer_id || null, tables: ev.tables_flyer_id || null };
      flyerRemove = {};
      $$('.flyer-pick[data-flyer]').forEach(function (box) {
        var fid = flyerState[box.dataset.flyer];
        showFlyer(box, fid ? media(fid, true) : null);
      });
      renderEventGrid();
    }
    $('eventForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function () { $('evTitle').focus({ preventScroll: true }); }, 300);
  }

  $('evPoster').addEventListener('change', function () {
    var f = this.files[0];
    if (!f) return;
    $('evPosterName').textContent = f.name;
    $('posterPreview').style.backgroundImage = "url('" + URL.createObjectURL(f) + "')";
  });

  $('eventForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('evSubmit');
    var id = $('evId').value;
    var body = {
      title: $('evTitle').value, starts_at: $('evStart').value, venue: $('evVenue').value,
      ticket_url: $('evTicket').value, tables_url: $('evTables').value, description: $('evDesc').value
    };
    var flyerFiles = { tickets: $('evFlyerTickets').files[0], tables: $('evFlyerTables').files[0] };
    var removeNow = Object.assign({}, flyerRemove);
    var poster = $('evPoster').files[0];
    busy(btn, true);
    var save = id ? call('PUT', '/api/admin/events/' + id, body).then(function () { return id; })
      : call('POST', '/api/admin/events', body).then(function (r) { return r.id; });
    save.then(function (eventId) {
      if (!poster) return eventId;
      btn.textContent = 'Uploading poster…';
      var fd = new FormData();
      fd.append('category', 'event');
      fd.append('event_id', eventId);
      fd.append('cover', '1');
      fd.append('photos', poster);
      return call('POST', '/api/admin/photos', fd).then(function () { return eventId; });
    }).then(function (eventId) {
      // Flyers, one after the other.
      return ['tickets', 'tables'].reduce(function (p, kind) {
        return p.then(function () {
          if (flyerFiles[kind]) {
            btn.textContent = 'Uploading the ' + kind + ' flyer…';
            var fd = new FormData();
            fd.append('photo', flyerFiles[kind]);
            return call('POST', '/api/admin/events/' + eventId + '/flyers/' + kind, fd);
          }
          if (removeNow[kind]) return call('DELETE', '/api/admin/events/' + eventId + '/flyers/' + kind);
        });
      }, Promise.resolve());
    }).then(function () {
      busy(btn, false);
      resetEventForm();
      toast(id ? 'Event updated' : 'Event added. It is live on the website.');
      return loadAll();
    }).catch(function (err) {
      busy(btn, false);
      say($('evMsg'), err.message, false);
      loadAll();
    });
  });

  // ---------- event photos ----------
  var currentEvent = null;

  function openEventPhotos(ev) {
    $('eventPhotosTitle').textContent = ev.title;
    $('evPhotosMsg').hidden = true;
    $('evPhotosInput').value = '';
    $('evPhotosName').textContent = 'Up to 20 at a time';
    openDrawer('photosDrawer');
    currentEvent = ev;
    loadEventPhotos();
    loadEventDrive(ev);
  }

  // The Google Drive box in an event's photos drawer.
  function loadEventDrive(ev) {
    var box = $('evDriveBox');
    box.textContent = '';
    get('/api/admin/events/' + ev.id + '/drive').then(function (d) {
      if (currentEvent !== ev) return;
      if (!d.linked) {
        box.appendChild(el('b', { text: 'Photos in Google Drive?' }));
        box.appendChild(el('p', { text: 'Bring in every photo from a shared Drive folder. Photos added to the folder later come in by themselves.' }));
        box.appendChild(el('div', { class: 'btn-row' }, [el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Add from Google Drive', onclick: function () { openDrive(ev); } })]));
        return;
      }
      box.appendChild(el('b', { text: 'Linked to Google Drive' }));
      box.appendChild(el('p', {}, [
        el('a', { href: d.url, target: '_blank', rel: 'noopener', text: d.name || 'Open the folder', style: 'text-decoration:underline;' }),
        '. New photos in this folder are brought in every few hours' + (d.synced_at ? ' (last checked ' + fmtDate(d.synced_at) + ' at ' + fmtTime(d.synced_at) + ').' : '.')
      ]));
      var syncBtn = el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Check for new photos now' });
      syncBtn.addEventListener('click', function () {
        busy(syncBtn, true, 'Checking…');
        call('POST', '/api/admin/events/' + ev.id + '/drive/sync').then(function () {
          toast('Checking the folder. New photos appear here in a moment.');
          watchImports(function () { loadEventPhotos(); });
        }).catch(function (err) { toast(err.message); }).then(function () { busy(syncBtn, false); });
      });
      var unlink = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Stop linking', title: 'Photos already brought in stay' });
      unlink.addEventListener('click', function () {
        if (!confirm('Stop bringing in new photos from this folder? Photos already on the website stay.')) return;
        call('DELETE', '/api/admin/events/' + ev.id + '/drive').then(function () { loadEventDrive(ev); }).catch(function (err) { toast(err.message); });
      });
      box.appendChild(el('div', { class: 'btn-row' }, [syncBtn, unlink]));
    }).catch(function () { /* box stays empty */ });
  }

  function loadEventPhotos() {
    var ev = currentEvent;
    if (!ev) return;
    get('/api/events/' + ev.id).then(function (data) {
      if (currentEvent !== ev) return;
      var grid = $('eventPhotoGrid');
      grid.textContent = '';
      if (!data.photos.length) { grid.appendChild(el('p', { class: 'empty', text: 'No photos yet. The first one you upload becomes the cover.' })); return; }
      data.photos.forEach(function (p) {
        var isCover = data.event.cover_media_id === p.id;
        grid.appendChild(photoTile(p, {
          badge: isCover ? el('span', { class: 'badge', text: 'Cover' }) : null,
          extra: isCover ? [] : [el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Make cover', onclick: function () {
            call('POST', '/api/admin/events/' + ev.id + '/cover', { media_id: p.id }).then(function () { toast('Cover updated'); loadEventPhotos(); loadAll(); })
              .catch(function (err) { alert(err.message); });
          } })],
          onChange: function () { loadEventPhotos(); loadAll(); }
        }));
      });
    }).catch(function (err) { say($('evPhotosMsg'), err.message, false); });
  }

  $('evPhotosInput').addEventListener('change', function () {
    $('evPhotosName').textContent = this.files.length ? plural(this.files.length, 'photo') + ' selected' : 'Up to 20 at a time';
  });

  $('evPhotosUpload').addEventListener('click', function () {
    var files = $('evPhotosInput').files;
    if (!files.length) { say($('evPhotosMsg'), 'Choose photos first.', false); return; }
    uploadInBatches(files, { category: 'event', event_id: currentEvent.id }, this).then(function (n) {
      say($('evPhotosMsg'), plural(n, 'photo') + ' added.', true);
      $('evPhotosInput').value = '';
      $('evPhotosName').textContent = 'Up to 20 at a time';
      loadEventPhotos();
      loadAll();
    }).catch(function (err) { say($('evPhotosMsg'), err.message, false); loadEventPhotos(); });
  });

  // Uploads a few at a time so phones on slow connections don't time out.
  function uploadInBatches(files, fields, btn) {
    var list = Array.prototype.slice.call(files);
    var done = 0;
    busy(btn, true, 'Uploading…');
    function next() {
      if (done >= list.length) return Promise.resolve(done);
      var batch = list.slice(done, done + 4);
      var fd = new FormData();
      Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
      batch.forEach(function (f) { fd.append('photos', f); });
      btn.textContent = 'Uploading ' + Math.min(done + batch.length, list.length) + ' of ' + list.length + '…';
      return call('POST', '/api/admin/photos', fd).then(function () { done += batch.length; return next(); });
    }
    return next().then(function (n) { busy(btn, false); return n; }, function (err) { busy(btn, false); throw err; });
  }

  // Asks the person to pick one file, then calls done(file).
  function pickFile(accept, done) {
    var input = el('input', { type: 'file', accept: accept, style: 'display:none' });
    input.addEventListener('change', function () { if (input.files[0]) done(input.files[0]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  }

  function replacePhoto(id, accept, btn, after) {
    pickFile(accept, function (file) {
      var fd = new FormData();
      fd.append('file', file);
      if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
      call('POST', '/api/admin/photos/' + id + '/replace', fd).then(function (r) {
        toast(r && r.compressing ? 'Video replaced. It is being made smaller in the background.' : 'Photo replaced');
        after();
      }).catch(function (err) {
        alert(err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Replace'; }
      });
    });
  }

  function photoTile(p, opts) {
    opts = opts || {};
    var caption = el('input', { type: 'text', value: p.caption || '', maxlength: '200', placeholder: 'Add a caption', 'aria-label': 'Caption' });
    var save = el('button', { class: 'btn btn-dark btn-sm', type: 'button', text: 'Save', hidden: true, onclick: function () {
      call('PUT', '/api/admin/photos/' + p.id, { caption: caption.value }).then(function () { save.hidden = true; p.caption = caption.value; toast('Caption saved'); })
        .catch(function (err) { alert(err.message); });
    } });
    caption.addEventListener('input', function () { save.hidden = caption.value === (p.caption || ''); });
    caption.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!save.hidden) save.click(); } });
    var replaceBtn = el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Replace' });
    replaceBtn.addEventListener('click', function () { replacePhoto(p.id, 'image/*', replaceBtn, opts.onChange); });
    return el('div', { class: 'ph' }, [
      el('a', { class: 'ph-img', href: media(p.id), target: '_blank', rel: 'noopener', style: "background-image:url('" + media(p.id, true) + "')", 'aria-label': 'Open full size photo' }, [
        opts.badge || null
      ]),
      el('div', { class: 'ph-body' }, [
        p.event_title ? el('small', { text: p.event_title }) : null,
        caption,
        el('div', { class: 'ph-btns' }, (opts.extra || []).concat([
          save,
          replaceBtn,
          el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: function () {
            if (!confirm('Delete this photo from the website?')) return;
            call('DELETE', '/api/admin/photos/' + p.id).then(function () { toast('Photo deleted'); opts.onChange(); }).catch(function (err) { alert(err.message); });
          } })
        ]))
      ])
    ]);
  }

  function segment(id, onChange) {
    var seg = $(id);
    seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        onChange(b.dataset.val);
      });
    });
  }
  segment('eventFilterSeg', function (v) { eventsState.f = v; renderEventGrid(); });

  // ---------- website picture spots (up to 5 photos each) ----------
  var slotData = { max: 5, slots: [] };
  var VIDEO_TYPES = 'image/*,video/mp4,video/webm,video/quicktime';

  function loadSlots() {
    return get('/api/admin/slots').then(function (d) {
      slotData = d;
      renderSlots();
      fillTargets();
    }).catch(function (err) { toast(err.message); });
  }
  function slotByKey(key) { return slotData.slots.filter(function (s) { return s.key === key; })[0]; }
  function slotLabel(key) { var s = slotByKey(key); return s ? s.label : 'Website'; }

  function afterSlotChange() { loadSlots(); refreshStats(); }

  function slotCard(slot, opts) {
    opts = opts || {};
    var max = slotData.max;
    var n = slot.items.length;
    var tiles = slot.items.map(function (item, i) {
      var isVideo = /^video\//.test(item.mime);
      var preview = isVideo
        ? el('video', { class: 'slot-media', src: media(item.id), muted: true, playsinline: true, preload: 'metadata' })
        : el('span', { class: 'slot-media', style: "background-image:url('" + media(item.id, true) + "')" });
      if (isVideo) preview.muted = true;
      // Icon + word; on small tiles only the icon shows (the word stays as its label).
      var replaceBtn = el('button', { type: 'button', class: 'slot-btn', title: 'Replace', 'aria-label': 'Replace this ' + (isVideo ? 'video' : 'photo') },
        [svgIcon('M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'), el('span', { text: 'Replace' })]);
      replaceBtn.addEventListener('click', function () { replacePhoto(item.id, slot.video ? VIDEO_TYPES : 'image/*', replaceBtn, afterSlotChange); });
      var deleteBtn = el('button', { type: 'button', class: 'slot-btn danger', title: 'Delete', 'aria-label': 'Delete this ' + (isVideo ? 'video' : 'photo') },
        [svgIcon('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'), el('span', { text: 'Delete' })]);
      deleteBtn.addEventListener('click', function () {
        if (!confirm('Remove this ' + (isVideo ? 'video' : 'photo') + ' from "' + slot.label + '"?')) return;
        call('DELETE', '/api/admin/photos/' + item.id).then(function () { toast('Removed'); afterSlotChange(); }).catch(function (err) { alert(err.message); });
      });
      return el('div', { class: 'slot-tile' }, [
        preview,
        el('span', { class: 'slot-n', text: isVideo ? 'Video' : String(i + 1) }),
        el('div', { class: 'slot-actions' }, [replaceBtn, deleteBtn])
      ]);
    });
    if (n < max) {
      var input = el('input', { type: 'file', accept: slot.video ? VIDEO_TYPES : 'image/*', multiple: true });
      var addLabel = el('b', { text: '+ Add photo' + (slot.video ? ' or video' : '') });
      var addTile = el('label', { class: 'slot-tile slot-add' }, [addLabel, el('small', { text: (max - n) + ' of ' + max + ' spaces left' }), input]);
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files, 0, max - n);
        if (!files.length) return;
        var fd = new FormData();
        files.forEach(function (f) { fd.append('files', f); });
        addLabel.textContent = 'Uploading…';
        call('POST', '/api/admin/slots/' + slot.key, fd).then(function (r) {
          toast(r.compressing ? 'Video added. It is being made smaller in the background, the website keeps working.' : (files.some(function (f) { return /^video\//.test(f.type); }) ? 'Video added to ' : plural(r.ids.length, 'photo') + ' added to ') + slot.label);
          afterSlotChange();
        }).catch(function (err) { alert(err.message); addLabel.textContent = '+ Add photo'; input.value = ''; });
      });
      tiles.unshift(addTile); // the Add tile comes first; photos follow on its right
    }
    var extra = null;
    if (opts.withWords && /^exp[123]$/.test(slot.key)) {
      var name = slot.key + '_label';
      var word = el('input', { type: 'text', name: name, maxlength: '30', value: settings[name] || '', 'aria-label': 'Word on this card' });
      extra = el('div', { class: 'slot-word' }, [el('label', { text: 'Word on the card' }), word]);
    }
    return el('div', { class: 'slot-card' + (slot.key === 'hero' ? ' slot-wide' : ''), 'data-slot': slot.key }, [
      el('div', { class: 'slot-head' }, [
        el('div', null, [el('b', { text: slot.label }), el('small', { text: slot.where + (slot.video ? '. Photos, or one short video.' : '') })]),
        el('span', { class: 'slot-count' + (n >= max ? ' full' : ''), text: n + ' of ' + max })
      ]),
      extra,
      el('div', { class: 'slot-tiles' }, tiles)
    ]);
  }

  function renderSlots() {
    $$('[data-slots]').forEach(function (box) {
      var want = box.dataset.slots === 'all' ? slotData.slots.map(function (s) { return s.key; }) : box.dataset.slots.split(',');
      var inDetails = !!box.closest('#settingsForm');
      // Keep any word the person is typing on the Experience cards.
      var typed = {};
      box.querySelectorAll('input[name]').forEach(function (i) { typed[i.name] = i.value; });
      box.textContent = '';
      want.forEach(function (key) {
        var s = slotByKey(key);
        if (!s) return;
        var card = slotCard(s, { withWords: inDetails });
        var w = card.querySelector('input[name]');
        if (w && typed[w.name] !== undefined) w.value = typed[w.name];
        box.appendChild(card);
      });
    });
  }

  // ---------- photos page: upload to a spot or an event ----------
  function fillTargets() {
    var sel = $('upTarget');
    var current = sel.value;
    sel.textContent = '';
    var g1 = el('optgroup', { label: 'Website pictures' });
    slotData.slots.forEach(function (s) {
      var left = slotData.max - s.items.length;
      g1.appendChild(el('option', { value: 'slot:' + s.key, text: s.label + (left <= 0 ? ' (full)' : ' (' + left + ' left)') }));
    });
    sel.appendChild(g1);
    if (events.length) {
      var g2 = el('optgroup', { label: 'An event' });
      events.forEach(function (ev) { g2.appendChild(el('option', { value: 'event:' + ev.id, text: ev.title + ' (' + fmtDate(ev.starts_at) + ')' })); });
      sel.appendChild(g2);
    }
    if (current && sel.querySelector('option[value="' + current + '"]')) sel.value = current;
    updateTargetHint();
  }
  function updateTargetHint() {
    var v = $('upTarget').value || '';
    var hint = $('upTargetHint');
    var input = $('photoFiles');
    if (v.indexOf('slot:') === 0) {
      var s = slotByKey(v.slice(5));
      var left = slotData.max - s.items.length;
      hint.textContent = s.where + '. ' + (left <= 0 ? 'This spot is full: replace or delete a photo below first.' : 'Room for ' + plural(left, 'more photo') + '.') + (s.video ? ' You can also add one short video (MP4).' : '');
      input.accept = s.video ? VIDEO_TYPES : 'image/*';
    } else if (v.indexOf('event:') === 0) {
      hint.textContent = 'Photos show on the event page and in the gallery. The first 5 also play on its card under Recent events.';
      input.accept = 'image/*';
    }
  }
  $('upTarget').addEventListener('change', updateTargetHint);

  var photoCount = 0;
  function loadPhotos(reset) {
    var grid = $('photoGrid');
    if (reset) { grid.textContent = ''; photoCount = 0; }
    get('/api/photos?limit=24&category=event&offset=' + photoCount).then(function (data) {
      if (reset && !data.photos.length) grid.appendChild(el('p', { class: 'empty', text: 'No event photos yet.' }));
      data.photos.forEach(function (p) {
        grid.appendChild(photoTile(p, { onChange: function () { loadPhotos(true); loadAll(); } }));
      });
      photoCount += data.photos.length;
      $('photoMore').hidden = !data.more;
    }).catch(function (err) { toast(err.message); });
  }
  $('photoMore').addEventListener('click', function () { loadPhotos(false); });

  $('photoFiles').addEventListener('change', function () {
    $('photoFilesName').textContent = this.files.length ? plural(this.files.length, 'file') + ' selected' : "Phone photos are fine, they're shrunk automatically";
  });

  $('photoForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var files = $('photoFiles').files;
    var target = $('upTarget').value || '';
    var btn = $('photoSubmit');
    if (!files.length) { say($('photoMsg'), 'Choose photos first.', false); return; }
    var done = function (n) {
      say($('photoMsg'), plural(n, 'photo') + ' added.', true);
      $('photoFiles').value = '';
      $('photoFilesName').textContent = "Phone photos are fine, they're shrunk automatically";
      loadAll();
      loadPhotos(true);
    };
    if (target.indexOf('event:') === 0) {
      uploadInBatches(files, { category: 'event', event_id: target.slice(6) }, btn).then(done)
        .catch(function (err) { say($('photoMsg'), err.message, false); });
      return;
    }
    var fd = new FormData();
    Array.prototype.forEach.call(files, function (f) { fd.append('files', f); });
    busy(btn, true, 'Uploading…');
    call('POST', '/api/admin/slots/' + target.slice(5), fd).then(function (r) { busy(btn, false); done(r.ids.length); })
      .catch(function (err) { busy(btn, false); say($('photoMsg'), err.message, false); });
  });

  // ---------- storage gauge ----------
  function fmtMb(bytes) {
    var mb = bytes / 1048576;
    if (mb >= 1000) return (Math.round(mb / 102.4) / 10) + ' GB';
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
  }
  function renderStorage(stats) {
    var pct = Math.min(100, (stats.db_bytes / stats.storage_limit_bytes) * 100);
    var color = pct > 90 ? 'var(--red)' : pct > 75 ? '#e08a00' : 'var(--purple)';
    $$('[data-storage]').forEach(function (box) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'card-head' }, [
        el('span', { class: 'card-ic' }, [svgIcon('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3')]),
        el('h3', { text: 'Storage' })
      ]));
      box.appendChild(el('div', { class: 'gauge', style: '--pct:' + pct.toFixed(1) + ';--col:' + color }, [
        el('div', { class: 'gauge-in' }, [el('b', { text: Math.round(pct) + '%' }), el('small', { text: 'used' })])
      ]));
      box.appendChild(el('p', { class: 'storage-line' }, [el('b', { text: fmtMb(stats.db_bytes) }), ' of ' + fmtMb(stats.storage_limit_bytes) + ' used']));
      box.appendChild(el('p', { class: 'storage-free' }, [el('b', { text: fmtMb(Math.max(0, stats.storage_limit_bytes - stats.db_bytes)) }), ' free']));
      box.appendChild(el('p', { class: 'hint', style: 'text-align:center' }, [
        'Room for about ' + stats.photos_left.toLocaleString() + ' more photos. ' +
        plural(stats.photos, 'photo') + (stats.videos ? ' and ' + plural(stats.videos, 'video') : '') + ' on your site.' +
        (pct > 90 ? ' Almost full: delete old photos or ask Siweni to add more space.' : '')
      ]));
      box.appendChild(el('p', { class: 'storage-live' }, [el('span', { class: 'live-dot' }), 'Live from your storage · checked ' + new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date())]));
    });
  }
  function refreshStats() { get('/api/admin/stats').then(function (st) { renderStorage(st); }).catch(function () {}); }
  // Re-check storage every minute while the admin panel is open.
  setInterval(function () { if (!$('appView').hidden && !document.hidden) refreshStats(); }, 60000);

  // ---------- quick add from a social media post ----------
  var MONTHS_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function parsePost(raw) {
    var text = String(raw || '').replace(/\r/g, '');
    var noEmoji = function (s) { return s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ').replace(/[ \t]+/g, ' ').trim(); };
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var out = {};

    // Ticket link: prefer one that looks like a ticketing site.
    var urls = (text.match(/\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:africa|com|co\.zw|co\.za|net|org|events|tickets|io|me|zw|za)\/[^\s]*/gi) || [])
      .map(function (u) { return u.replace(/[)\].,!?]+$/, ''); });
    out.ticket = urls.filter(function (u) { return /ticket|megaticket|sahwigate|quicket|computicket|webtickets|tixafrica|eventbrite|howler/i.test(u); })[0] ||
      urls.filter(function (u) { return !/instagram|facebook|tiktok|wa\.me|whatsapp|linktr|youtube|twitter|x\.com/i.test(u); })[0] || '';

    // Time: "8pm", "8:30 PM", "20:00", "20h00".
    var t = text.match(/\b(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)\b/i);
    if (t) {
      var h = Number(t[1]) % 12 + (/pm/i.test(t[3]) ? 12 : 0);
      out.time = pad(h) + ':' + (t[2] || '00');
    } else if ((t = text.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/))) {
      out.time = pad(Number(t[1])) + ':' + t[2];
    }

    // Date: "13 Dec", "13th of December 2026", "Dec 13", "13/12", "13.12.26".
    var now = parts();
    var today = new Date(Number(now.year), Number(now.month) - 1, Number(now.day));
    var day, mon, yr, m;
    if ((m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s*(\d{4})?/i))) {
      day = Number(m[1]); mon = MONTHS_IDX[m[2].toLowerCase()]; yr = m[3] && Number(m[3]);
    } else if ((m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i))) {
      mon = MONTHS_IDX[m[1].toLowerCase()]; day = Number(m[2]); yr = m[3] && Number(m[3]);
    } else {
      var re = /\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/g;
      while ((m = re.exec(text))) {
        var d = Number(m[1]), mo = Number(m[2]);
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
          day = d; mon = mo - 1; yr = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : null;
          break;
        }
      }
    }
    if (day && mon !== undefined) {
      var y = yr || today.getFullYear();
      if (!yr && new Date(y, mon, day) < new Date(today.getTime() - 86400000)) y += 1; // next one coming up
      out.date = y + '-' + pad(mon + 1) + '-' + pad(day);
    }

    // Venue: a 📍 line, or "Venue:/Location:/Where:", or "@ Some Place".
    var venueLine = lines.filter(function (l) { return /📍|^\s*(venue|location|where|address)\b/i.test(l); })[0];
    if (venueLine) {
      out.venue = noEmoji(venueLine.replace(/📍/g, '')).replace(/^(venue|location|where|address)\s*[:\-–]?\s*/i, '');
    } else if ((m = text.match(/(?:^|\s)@\s+([^\n#@]{3,60})/))) {
      out.venue = noEmoji(m[1]);
    } else if ((m = text.match(/\bat\s+((?:[A-Z][\w'&.-]*\s?){1,6})/))) {
      // "...on Dec 27 at Palm Tree Terrace from 7pm": a run of Capitalised Words after "at".
      out.venue = m[1].trim().replace(/\s+(From|On|Till|Until)$/, '');
    }
    if (out.venue) out.venue = out.venue.replace(/\s*[|·•]\s*$/, '').slice(0, 120);

    // Name: the first proper line that isn't a date, time, venue, link or hashtags.
    var titleLine = lines.map(noEmoji).filter(function (l) {
      if (l.length < 3 || /^#/.test(l) || /https?:|www\./i.test(l)) return false;
      if (venueLine && noEmoji(venueLine).indexOf(l) >= 0) return false;
      if (/^(date|time|venue|location|where|tickets?|entry|dress ?code)\b/i.test(l)) return false;
      return /[a-z]/i.test(l);
    })[0] || '';
    titleLine = titleLine.replace(/^(rnb|r&b|r ?n ?b)\s*dancehall\s*lovers\s*(presents?|brings you)\s*[:\-–]?\s*/i, '').replace(/[!.:]+$/, '').trim();
    if (titleLine && titleLine === titleLine.toUpperCase()) {
      titleLine = titleLine.toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); }).replace(/\bR&b\b/g, 'R&B').replace(/\bRnb\b/g, 'RnB');
    }
    out.title = titleLine.slice(0, 120);

    // Description: the post without hashtag-only lines.
    out.description = lines.filter(function (l) { return !/^(#\S+\s*)+$/.test(l); }).join('\n').slice(0, 1500);
    return out;
  }

  // Fills the event form from a post's words. hasPoster: the post's picture was set as the poster.
  function fillFromText(text, hasPoster) {
    var r = parsePost(text);
    var found = [], missing = [];
    if (r.title) { $('evTitle').value = r.title; found.push('name'); } else missing.push('event name');
    if (r.date) { $('evStart').value = r.date + 'T' + (r.time || '20:00'); found.push('date'); if (!r.time) missing.push('start time (we put 8pm)'); else found.push('time'); }
    else missing.push('date');
    if (r.venue) { $('evVenue').value = r.venue; found.push('venue'); } else missing.push('venue');
    if (r.ticket) { $('evTicket').value = r.ticket; found.push('ticket link'); }
    if (r.description) $('evDesc').value = r.description;
    if (hasPoster) found.push('poster');
    var msg = found.length ? 'Done! We filled in the ' + found.join(', ') + '. ' : "We couldn't find the event details in that post. ";
    if (missing.length) msg += 'Please check or add: ' + missing.join(', ') + '. ';
    msg += hasPoster ? 'Check everything, then press Add event.' : 'Add the flyer as the poster, then press Add event.';
    say($('qaMsg'), msg, found.length > 0);
    $('qaMsg').className = 'msg ' + (missing.length ? 'warn' : 'ok');
  }

  // Puts the post's picture into the poster box, as if it had been chosen by hand.
  function setPosterFromDataUrl(dataUrl) {
    try {
      var bytes = atob(dataUrl.split(',')[1]);
      var arr = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      var file = new File([arr], 'poster-from-post.webp', { type: 'image/webp' });
      var dt = new DataTransfer();
      dt.items.add(file);
      $('evPoster').files = dt.files;
      $('evPoster').dispatchEvent(new Event('change'));
      return true;
    } catch (e) { return false; }
  }

  $('qaFetch').addEventListener('click', function () {
    var link = $('qaLink').value.trim();
    if (!link) { say($('qaMsg'), 'Paste the link to your post first.', false); return; }
    var btn = this;
    busy(btn, true, 'Reading your post…');
    call('POST', '/api/admin/import-post', { url: link }).then(function (r) {
      var hasPoster = r.poster ? setPosterFromDataUrl(r.poster) : false;
      if (r.caption) {
        $('qaText').value = r.caption;
        fillFromText(r.caption, hasPoster);
      } else {
        say($('qaMsg'), 'We got the picture but the post has no caption. ' + (hasPoster ? "It's set as the poster. " : '') + 'Please type the name, date and venue, or paste the words below.', false);
        $('qaMsg').className = 'msg warn';
        openPaste();
      }
    }).catch(function (err) {
      say($('qaMsg'), err.message, false);
      openPaste();
    }).then(function () { busy(btn, false); });
  });
  $('qaLink').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('qaFetch').click(); } });

  function openPaste() { $('qaPaste').hidden = false; $('qaToggle').setAttribute('aria-expanded', 'true'); }
  $('qaToggle').addEventListener('click', function () {
    var open = $('qaPaste').hidden;
    $('qaPaste').hidden = !open;
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) $('qaText').focus();
  });

  $('qaFill').addEventListener('click', function () {
    var text = $('qaText').value.trim();
    if (!text) { say($('qaMsg'), 'Paste the words from your post into the box first.', false); return; }
    fillFromText(text, false);
  });

  // ---------- website details ----------
  var settingsForm = $('settingsForm');
  function fillSettings() {
    Array.prototype.forEach.call(settingsForm.elements, function (input) {
      if (input.name && input.name in settings && document.activeElement !== input) input.value = settings[input.name];
    });
  }
  settingsForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {};
    Array.prototype.forEach.call(settingsForm.elements, function (input) { if (input.name) body[input.name] = input.value; });
    var btn = $('settingsSubmit');
    busy(btn, true);
    call('PUT', '/api/admin/settings', body).then(function (s) {
      settings = s;
      say($('settingsMsg'), 'Saved. The website is updated.', true);
      toast('Website details saved');
      loadAll();
    }).catch(function (err) { say($('settingsMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });

  // ---------- Google Drive ----------
  var driveLook = null, driveMode = '', driveForEvent = null;
  var DRIVE_IC = '<svg viewBox="0 0 24 24"><path d="M8 3h8l6 10-4 7H6l-4-7z"/><path d="M8 3l6 10M16 3 10 13M2 13h20"/></svg>';
  function openDrive(ev) {
    driveForEvent = ev || null;
    closeDrawers();
    $('driveLookForm').hidden = false;
    $('driveImportForm').hidden = true;
    $('driveLookMsg').hidden = true;
    $('driveImportMsg').hidden = true;
    $('driveLink').value = '';
    $('driveTitle').textContent = ev ? 'Photos for ' + ev.title : 'Add from Google Drive';
    openDrawer('driveDrawer');
    loadImports();
    setTimeout(function () { $('driveLink').focus(); }, 300);
  }
  $$('[data-action="drive"]').forEach(function (b) { b.addEventListener('click', function () { openDrive(null); }); });
  $('driveAgain').addEventListener('click', function () { $('driveImportForm').hidden = true; $('driveLookForm').hidden = false; $('driveLink').focus(); });

  $('driveLookForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button[type=submit]');
    busy(btn, true, 'Looking in the folder…');
    call('POST', '/api/admin/drive/look', { url: $('driveLink').value }).then(function (d) {
      driveLook = d;
      $('driveLookMsg').hidden = true;
      if (!d.folder.images && !d.folders.length) return say($('driveLookMsg'), 'This folder has no photos in it. Check that it is the right folder.', false);
      showDriveChoices();
    }).catch(function (err) { say($('driveLookMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });

  function showDriveChoices() {
    var d = driveLook, f = d.folder;
    var withPhotos = d.folders.filter(function (x) { return x.images > 0 || x.folders > 0; });
    var sum = $('driveSummary');
    sum.innerHTML = '';
    var ic = el('span', { class: 'ic' }); ic.innerHTML = DRIVE_IC;
    var parts = [];
    if (f.images) parts.push(plural(f.images, 'photo'));
    if (d.folders.length) parts.push(plural(d.folders.length + d.more_folders, 'folder'));
    sum.appendChild(ic);
    sum.appendChild(el('div', null, [el('b', { text: f.name }), el('small', { text: parts.join(' and ') || 'Empty' })]));

    var modes = [];
    if (driveForEvent) modes.push(['existing', 'Add to ' + driveForEvent.title]);
    else {
      if (withPhotos.length) modes.push(['many', 'One event per folder']);
      modes.push(['new', 'Make one new event']);
      if (events.length) modes.push(['existing', 'Add to an event']);
    }
    driveMode = modes[0][0];
    var seg = $('driveModeSeg');
    seg.textContent = '';
    seg.hidden = modes.length < 2;
    modes.forEach(function (m) {
      var b = el('button', { type: 'button', role: 'radio', 'aria-checked': m[0] === driveMode ? 'true' : 'false', text: m[1] });
      b.addEventListener('click', function () {
        driveMode = m[0];
        $$('#driveModeSeg button').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        renderDriveMode();
      });
      seg.appendChild(b);
    });
    if (d.linked.length) say($('driveImportMsg'), 'Already linked: ' + d.linked.map(function (x) { return x.title; }).join(', ') + '. Bringing it in again only adds new photos.', true);
    else $('driveImportMsg').hidden = true;
    $('driveLookForm').hidden = true;
    $('driveImportForm').hidden = false;
    renderDriveMode();
  }

  function dateInput(value) { return el('input', { type: 'date', value: value || '', required: true, 'aria-label': 'Event date' }); }
  function renderDriveMode() {
    var d = driveLook, box = $('driveModeBody');
    box.textContent = '';
    if (driveMode === 'existing') {
      var total = d.folder.images + d.folders.reduce(function (n, x) { return n + x.images; }, 0);
      if (driveForEvent) {
        box.appendChild(el('p', { class: 'hint', text: 'Every photo in this folder (and the folders inside it) is added to ' + driveForEvent.title + '. About ' + plural(total, 'photo') + '.' }));
        return;
      }
      box.appendChild(el('label', { for: 'driveEvent', text: 'Which event?' }));
      var sel = el('select', { id: 'driveEvent' });
      events.slice().sort(function (a, b) { return b.starts_at < a.starts_at ? -1 : 1; }).forEach(function (ev) {
        sel.appendChild(el('option', { value: ev.id, text: ev.title + ' · ' + fmtDate(ev.starts_at) }));
      });
      box.appendChild(sel);
      box.appendChild(el('p', { class: 'hint', text: 'About ' + plural(total, 'photo') + ' will be added to that event.' }));
      return;
    }
    if (driveMode === 'new') {
      box.appendChild(el('label', { for: 'driveNewTitle', text: 'Event name' }));
      box.appendChild(el('input', { type: 'text', id: 'driveNewTitle', maxlength: 200, value: d.folder.name, required: true }));
      box.appendChild(el('label', { for: 'driveNewDate', text: 'Date of the event' }));
      var di = dateInput(d.folder.date); di.id = 'driveNewDate'; box.appendChild(di);
      box.appendChild(el('label', { for: 'driveNewVenue', text: 'Venue (optional)' }));
      box.appendChild(el('input', { type: 'text', id: 'driveNewVenue', maxlength: 200 }));
      box.appendChild(el('p', { class: 'hint', text: 'All photos in this folder and the folders inside it go into this one event.' }));
      return;
    }
    // one event per folder
    var list = el('div', { class: 'drive-folders' });
    d.folders.forEach(function (f) {
      var has = f.images > 0 || f.folders > 0;
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Bring in ' + f.name });
      cb.checked = has; cb.disabled = !has;
      var title = el('input', { type: 'text', maxlength: 200, value: f.name, 'aria-label': 'Event name' });
      var date = dateInput(f.date);
      date.required = has; title.required = has;
      var venue = el('input', { type: 'text', maxlength: 200, placeholder: 'Venue (optional)', 'aria-label': 'Venue' });
      var row = el('div', { class: 'drive-folder' + (has ? '' : ' off'), 'data-folder': f.id }, [
        cb,
        el('div', null, [
          el('div', { class: 'row3' }, [title, date, venue]),
          el('small', { text: f.error ? 'Could not open this folder' : has ? plural(f.images, 'photo') + (f.folders ? ' + ' + plural(f.folders, 'folder') + ' inside' : '') + (f.date ? '' : ' · pick the date') : 'No photos' })
        ])
      ]);
      row._get = function () { return cb.checked ? { folder_id: f.id, name: f.name, title: title.value, date: date.value, venue: venue.value } : null; };
      cb.addEventListener('change', function () { row.classList.toggle('off', !cb.checked); date.required = cb.checked; title.required = cb.checked; });
      list.appendChild(row);
    });
    if (d.more_folders) list.appendChild(el('p', { class: 'hint', text: plural(d.more_folders, 'more folder') + ' not shown. Bring in at most 30 at a time.' }));
    box.appendChild(el('p', { class: 'hint', text: 'Each folder becomes its own event with its photos. Check the names and dates (dates in folder names are filled in for you).' }));
    box.appendChild(list);
  }

  $('driveImportForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = driveLook, body;
    if (driveMode === 'existing') {
      body = { mode: 'existing', event_id: driveForEvent ? driveForEvent.id : Number($('driveEvent').value), folder_id: d.folder.id, resource_key: d.folder.resourceKey, name: d.folder.name };
    } else if (driveMode === 'new') {
      body = { mode: 'new', events: [{ folder_id: d.folder.id, resource_key: d.folder.resourceKey, name: d.folder.name, title: $('driveNewTitle').value, date: $('driveNewDate').value, venue: $('driveNewVenue').value }] };
    } else {
      var chosen = $$('#driveModeBody .drive-folder').map(function (r) { return r._get(); }).filter(Boolean);
      if (!chosen.length) return say($('driveImportMsg'), 'Tick at least one folder.', false);
      body = { mode: 'new', events: chosen };
    }
    var btn = $('driveImportBtn');
    busy(btn, true, 'Starting…');
    call('POST', '/api/admin/drive/import', body).then(function (r) {
      say($('driveImportMsg'), r.events.length > 1
        ? plural(r.events.length, 'event') + ' made. Their photos are being brought in now; you can close this and keep working.'
        : 'Bringing in the photos now. You can close this and keep working.', true);
      $('driveImportForm').hidden = true;
      $('driveLookForm').hidden = false;
      $('driveLink').value = '';
      loadAll();
      watchImports(function () { loadAll(); if (currentEvent) loadEventPhotos(); });
    }).catch(function (err) { say($('driveImportMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });

  function renderImports(list) {
    var box = $('driveJobs');
    box.textContent = '';
    if (!list.length) { box.appendChild(el('p', { class: 'hint', text: 'Nothing brought in yet.' })); return; }
    list.forEach(function (j) {
      var todo = Math.max(0, j.total - j.skipped);
      var doneN = j.added + j.failed;
      var pct = j.status === 'done' ? 100 : todo ? Math.round(doneN / todo * 100) : (j.status === 'running' ? 5 : 0);
      var line = j.status === 'pending' ? 'Waiting to start…'
        : j.status === 'running' ? (j.total ? 'Bringing in ' + doneN + ' of ' + todo + ' new photos…' : 'Looking in the folder…')
        : j.status === 'failed' ? 'Stopped: ' + j.error
        : (j.added ? plural(j.added, 'new photo') + ' added' : 'No new photos') + (j.failed ? ', ' + j.failed + ' could not be copied' : '') + (j.skipped ? ' · ' + j.skipped + ' already there' : '');
      box.appendChild(el('div', { class: 'drive-job' + (j.status === 'failed' ? ' failed' : '') }, [
        el('div', { class: 'top' }, [el('b', { text: j.title }), el('span', { class: 'muted', text: fmtDate(j.created_at) })]),
        el('div', { class: 'bar' }, [el('span', { style: 'width:' + pct + '%' })]),
        el('small', { text: line + (j.automatic ? ' (automatic check)' : '') })
      ]));
    });
  }
  function loadImports() {
    return get('/api/admin/drive/imports').then(function (r) { renderImports(r.imports); return r.imports; }).catch(function () { return []; });
  }
  // Refreshes progress every few seconds until all imports have finished.
  var watching = null;
  function watchImports(onChange) {
    if (watching) clearTimeout(watching);
    var lastAdded = -1;
    (function tick() {
      loadImports().then(function (list) {
        var added = list.reduce(function (n, j) { return n + j.added; }, 0);
        if (added !== lastAdded && lastAdded >= 0 && onChange) onChange();
        lastAdded = added;
        var active = list.some(function (j) { return j.status === 'pending' || j.status === 'running'; });
        if (active) watching = setTimeout(tick, 4000);
        else { watching = null; if (onChange) onChange(); }
      });
    })();
  }

  // ---------- passwords ----------
  $$('.pw-toggle').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = $(b.dataset.pw);
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
  // Rough strength bar: length and variety. The server makes the real check.
  function strength(pw) {
    var score = Math.min(pw.length, 20) / 20 * 70;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 10;
    if (/\d/.test(pw)) score += 10;
    if (/[^A-Za-z0-9]/.test(pw)) score += 10;
    if (pw.length < 10) score = Math.min(score, 30);
    return Math.min(100, score);
  }
  $$('[data-meter]').forEach(function (m) {
    var input = $(m.dataset.meter), bar = m.querySelector('span');
    input.addEventListener('input', function () {
      var v = strength(input.value);
      bar.style.width = v + '%';
      bar.style.background = v < 45 ? 'var(--red)' : v < 75 ? '#e0a100' : '#1f9d55';
    });
  });
  $('forgotBtn').addEventListener('click', function () { $('forgotNote').hidden = false; });

  $('setPwForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button[type=submit]');
    if ($('setPwNew').value !== $('setPwConfirm').value) return say($('setPwMsg'), 'The two new passwords are not the same.', false);
    busy(btn, true);
    var current = $('setPwCurrentBox').hidden ? lastPassword : $('setPwCurrent').value;
    var body = { current_password: current, new_password: $('setPwNew').value, remember: $('loginRemember').checked };
    if (me.temporary) { body.email = $('setPwEmail').value; body.name = $('setPwName').value; }
    call('POST', '/api/admin/account/password', body)
      .then(function (r) {
        setMe({ email: r.email, name: r.name });
        try { localStorage.setItem('rnbLoginEmail', r.email); } catch (e2) { /* ignore */ }
        lastPassword = '';
        ['setPwCurrent', 'setPwNew', 'setPwConfirm'].forEach(function (id) { $(id).value = ''; });
        $('setPwMsg').hidden = true;
        showApp();
        toast('Your new password is saved.');
      })
      .catch(function (err) {
        if (/current password/i.test(err.message)) { $('setPwCurrentBox').hidden = false; lastPassword = ''; }
        say($('setPwMsg'), err.message, false);
      })
      .then(function () { busy(btn, false); });
  });
  $('setPwLogout').addEventListener('click', function () { lastPassword = ''; call('POST', '/api/admin/logout').then(showLogin, showLogin); });

  // ---------- account ----------
  function loadAccount() {
    get('/api/admin/account').then(function (a) {
      setMe(a);
      $('accName').value = a.name || '';
      $('accEmail').value = a.email;
      $('pwEmail').value = a.email;
      $('accPwBox').hidden = true;
      var bits = [];
      if (a.lastLoginAt) bits.push('Last login: ' + fmtDate(a.lastLoginAt) + ' at ' + fmtTime(a.lastLoginAt) + '.');
      bits.push(a.passwordChangedAt ? 'Password last changed ' + fmtDate(a.passwordChangedAt) + '.' : '');
      $('accountSeen').textContent = bits.join(' ');
    }).catch(function (err) { toast(err.message); });
  }
  $('accEmail').addEventListener('input', function () {
    $('accPwBox').hidden = $('accEmail').value.trim().toLowerCase() === me.email;
  });
  $('accountForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button[type=submit]');
    busy(btn, true);
    var oldEmail = me.email;
    call('PUT', '/api/admin/account', { name: $('accName').value, email: $('accEmail').value, current_password: $('accPw').value })
      .then(function (r) {
        setMe(r);
        $('accPw').value = '';
        $('accPwBox').hidden = true;
        $('pwEmail').value = r.email;
        try { localStorage.setItem('rnbLoginEmail', r.email); } catch (e2) { /* ignore */ }
        say($('accountMsg'), r.email !== oldEmail ? 'Saved. Log in with ' + r.email + ' from now on.' : 'Saved.', true);
      })
      .catch(function (err) { say($('accountMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });
  $('passwordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button[type=submit]');
    if ($('pwNew').value !== $('pwConfirm').value) return say($('passwordMsg'), 'The two new passwords are not the same.', false);
    busy(btn, true);
    call('POST', '/api/admin/account/password', { current_password: $('pwCurrent').value, new_password: $('pwNew').value })
      .then(function () {
        ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(function (id) { $(id).value = ''; });
        $$('[data-meter="pwNew"] span').forEach(function (b) { b.style.width = '0'; });
        say($('passwordMsg'), 'Password changed. Other phones and computers have been logged out.', true);
        loadAccount();
      })
      .catch(function (err) { say($('passwordMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });
  $('signOutAll').addEventListener('click', function () {
    if (!confirm('Log out on every phone and computer, including this one?')) return;
    call('POST', '/api/admin/account/sign-out-everywhere').then(showLogin, function (err) { toast(err.message); });
  });

  // ---------- website text ----------
  // The real website, section by section, in frames (public/js/edit-mode.js
  // runs inside them). Tapping words opens the edit sheet; typing shows the
  // new words in the frame straight away; Save puts them live.
  var tx = { fields: [], sections: [], page: '', view: 'phone', cards: [], key: null, observer: null };
  var TX_W = { phone: 390, computer: 1280 };
  var TX_H = { phone: 680, computer: 760 };       // first frame height (the header fills it)
  var TX_MAX = { phone: 760, computer: 860 };     // taller sections scroll inside the frame
  var TX_ICONS = {
    'Every page': '<svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
    'Home page': '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/></svg>',
    'Events page': '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    'Gallery page': '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>'
  };
  var TX_HELP = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/></svg>';

  function txField(key) { return tx.fields.filter(function (f) { return f.key === key; })[0]; }
  function txValue(f) { return f.value !== '' ? f.value : f.default; }
  function txPages() {
    var out = [];
    tx.sections.forEach(function (s) { if (out.indexOf(s.page) < 0) out.push(s.page); });
    return out;
  }
  function txFieldsOf(sec) { return tx.fields.filter(function (f) { return f.page === sec.page && f.section === sec.section; }); }

  // Same layout as content.js on the server, so typing shows the real look.
  var TX_RECENT = ['p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11'];
  function txEsc(v) { return String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function txLines(v) { return String(v).split('\n').map(function (l) { return l.trim(); }).filter(Boolean); }
  function txRepeat(v) {
    var w = txLines(v), out = [];
    if (!w.length) return '';
    while (out.length < 8) out = out.concat(w);
    return out.slice(0, Math.max(8, w.length)).map(function (x) { return '<span>' + txEsc(x) + '</span>'; }).join('');
  }
  function txRender(f, v) {
    switch (f.key) {
      case 'home_words': return txLines(v).map(function (w) { return '<span>' + txEsc(w) + '</span>'; }).join('');
      case 'merch_items': return txLines(v).map(function (w) { return '<div class="pill">' + txEsc(w) + '</div>'; }).join('');
      case 'recent_cards': return txLines(v).slice(0, 8).map(function (l, i) {
        var p = l.split('|').map(function (x) { return x.trim(); });
        return '<div class="case-card ph ' + TX_RECENT[i] + '"><div class="meta">' + txEsc(p[0]) + '<small>' + txEsc(p[1] || '') + '</small></div></div>';
      }).join('');
      case 'banner_scroll': return new Array(9).join('<span>' + txEsc(v) + '</span>');
      case 'join1_words': case 'join2_words': return txRepeat(v);
    }
    if (f.type === 'heading') {
      var open = f.accent === 'dark' ? '<span style="color:#141108">' : '<span class="accent">';
      return txLines(v).map(function (l) { return txEsc(l).replace(/\*([^*]+)\*/g, open + '$1</span>').replace(/\*/g, ''); }).join('<br>');
    }
    if (f.type === 'text') return txLines(v).map(txEsc).join('<br>');
    if (f.type === 'list') return txLines(v).map(txEsc).join(', ');
    return txEsc(v);
  }
  function txSend(win, msg) { try { win.postMessage(msg, location.origin); } catch (e) { /* frame gone */ } }
  function txShowEverywhere(f, v) {
    var html = txRender(f, v);
    tx.cards.forEach(function (c) { if (c.frame && c.frame.contentWindow) txSend(c.frame.contentWindow, { rnb: 'set', key: f.key, html: html, text: v }); });
    tx.cards.forEach(function (c) { if (c.mock) c.mock(); });
  }

  function loadText() {
    return get('/api/admin/content').then(function (d) {
      tx.fields = d.fields;
      tx.sections = d.sections.filter(function (s) { return tx.fields.some(function (f) { return f.page === s.page && f.section === s.section; }); });
      if (!tx.page) tx.page = tx.sections[0].page;
      if (!tx.view0) { tx.view0 = true; if (window.innerWidth >= 1100) tx.view = 'computer'; }
      txRenderPages();
      txRenderCards();
    }).catch(function (err) { say($('textMsg'), err.message, false); });
  }

  function txRenderPages() {
    var bar = $('txPages');
    bar.textContent = '';
    txPages().forEach(function (p) {
      var secs = tx.sections.filter(function (s) { return s.page === p; }).length;
      var changed = tx.fields.filter(function (f) { return f.page === p && f.value !== ''; }).length;
      var ic = el('span', { class: 'ic' });
      ic.innerHTML = TX_ICONS[p] || TX_HELP;
      var b = el('button', { type: 'button', class: 'tx-page', role: 'tab', 'aria-selected': p === tx.page ? 'true' : 'false' }, [
        ic,
        el('b', { text: p }),
        el('small', { text: secs === 1 ? '1 section' : secs + ' sections' }),
        changed ? el('span', { class: 'n', text: changed + ' changed' }) : null
      ]);
      b.addEventListener('click', function () {
        if (tx.page === p) return;
        tx.page = p;
        txRenderPages();
        txRenderCards();
      });
      bar.appendChild(b);
    });
    var on = bar.querySelector('[aria-selected="true"]');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function txRow(f, onScreen) {
    var changed = f.value !== '';
    var b = el('button', { type: 'button', class: 'tx-row', 'data-key': f.key }, [
      el('span', { class: 'txt' }, [el('b', { text: f.label }), el('span', { text: txValue(f).replace(/\n/g, ' / ') })]),
      changed ? el('span', { class: 'tag changed', text: 'Changed' }) : null,
      onScreen === false ? el('span', { class: 'tag', text: 'Not showing now' }) : null,
      (function () { var p = el('span', { class: 'pen', 'aria-hidden': 'true' }); p.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>'; return p; })()
    ]);
    b.addEventListener('click', function () { txOpen(f.key); });
    return b;
  }

  function txRenderCards() {
    var track = $('txTrack');
    if (tx.observer) tx.observer.disconnect();
    tx.cards.forEach(function (c) { if (c.frame) c.frame.src = 'about:blank'; });
    tx.cards = [];
    track.textContent = '';
    track.classList.toggle('computer', tx.view === 'computer');
    $$('.tx-view button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.view === tx.view ? 'true' : 'false'); });
    var secs = tx.sections.filter(function (s) { return s.page === tx.page; });
    secs.forEach(function (sec, i) {
      var fields = txFieldsOf(sec);
      var changed = fields.filter(function (f) { return f.value !== ''; }).length;
      var card = el('article', { class: 'tx-card', 'aria-label': sec.section }, [
        el('div', { class: 'tx-card-head' }, [
          el('span', { class: 'num', text: String(i + 1) }),
          el('h3', { text: sec.section }),
          changed ? el('span', { class: 'n', text: changed + ' changed' }) : null
        ])
      ]);
      var c = { sec: sec, el: card, fields: fields, frame: null, box: null, list: null, keys: null };
      if (sec.url) {
        c.box = el('div', { class: 'tx-frame' }, [el('div', { class: 'tx-wait', text: 'Loading the website…' })]);
        card.appendChild(c.box);
        card.appendChild(el('p', { class: 'tx-tip', text: 'Tap the words with a dotted line to change them.' }));
      } else {
        txMock(c);
      }
      c.list = el('div', { class: 'tx-fields' });
      card.appendChild(c.list);
      txFillList(c);
      tx.cards.push(c);
      track.appendChild(card);
    });
    var dots = $('txDots');
    dots.textContent = '';
    secs.forEach(function () { dots.appendChild(el('span')); });
    track.scrollLeft = 0;
    // Frames load as their card comes near, so a page with 11 sections
    // doesn't open the website 11 times at once.
    if ('IntersectionObserver' in window) {
      tx.observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var c = tx.cards.filter(function (x) { return x.el === e.target; })[0];
          if (c) txLoadFrame(c);
        });
      }, { root: track, rootMargin: '0px 120% 0px 120%' });
      tx.cards.forEach(function (c) { tx.observer.observe(c.el); });
    } else tx.cards.forEach(txLoadFrame);
    txWhere();
  }

  function txFillList(c) {
    c.list.textContent = '';
    var label = c.sec.url ? 'All the words in this section' : 'Words in this section';
    c.list.appendChild(el('p', { text: label }));
    c.fields.forEach(function (f) { c.list.appendChild(txRow(f, c.keys ? c.keys.indexOf(f.key) >= 0 : undefined)); });
  }

  function txLoadFrame(c) {
    if (c.frame || !c.sec.url) return;
    var w = TX_W[tx.view];
    var q = 'rnbedit=1&only=' + encodeURIComponent(c.sec.show || '') + (c.sec.hero ? '' : '&hero=0');
    var frame = el('iframe', { title: 'Preview: ' + c.sec.section, loading: 'eager', scrolling: 'yes' });
    frame.style.width = w + 'px';
    frame.style.height = TX_H[tx.view] + 'px';
    c.frame = frame;
    c.h = TX_H[tx.view];
    c.box.insertBefore(frame, c.box.firstChild);
    txScale(c);
    frame.src = c.sec.url + (c.sec.url.indexOf('?') < 0 ? '?' : '&') + q;
  }
  function txScale(c) {
    if (!c.frame) return;
    var w = TX_W[tx.view];
    var s = c.box.clientWidth / w || 1;
    c.frame.style.transform = 'scale(' + s + ')';
    c.box.style.height = Math.round(c.h * s) + 'px';
  }
  window.addEventListener('resize', function () { tx.cards.forEach(txScale); });

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data.rnb !== 'string') return;
    var c = tx.cards.filter(function (x) { return x.frame && x.frame.contentWindow === e.source; })[0];
    if (!c) return;
    if (e.data.rnb === 'size') {
      var h = Math.max(120, Math.min(TX_MAX[tx.view], e.data.h || 0));
      if (Math.abs(h - c.h) > 2) { c.h = h; c.frame.style.height = h + 'px'; txScale(c); }
      c.box.classList.add('ready');
      var keys = (e.data.keys || []).slice().sort().join(',');
      if (keys !== (c.keys || []).slice().sort().join(',')) { c.keys = e.data.keys || []; txFillList(c); }
    } else if (e.data.rnb === 'edit') {
      txOpen(e.data.key, c);
    }
  });

  // Browser tab and sharing: show what Google and a shared link look like.
  function txMock(c) {
    var g = el('div', { class: 'tx-google' });
    var share = el('div', { class: 'tx-share' });
    c.el.appendChild(el('p', { class: 'tx-mock-label', text: 'On Google' }));
    c.el.appendChild(g);
    c.el.appendChild(el('p', { class: 'tx-mock-label', text: 'When the link is shared on WhatsApp' }));
    c.el.appendChild(share);
    c.mock = function () {
      var tf = c.fields.filter(function (f) { return /_title$/.test(f.key); })[0];
      var df = c.fields.filter(function (f) { return /_description$/.test(f.key); })[0];
      var title = txValue(tf || { value: '', default: '' });
      var desc = df ? txValue(df) : 'Official merchandise: caps, tees, jackets, cups and more. Pay with EcoCash or InnBucks.';
      var site = txValue(txField('site_name') || { value: '', default: '' });
      g.textContent = '';
      g.appendChild(el('div', { class: 'site' }, [el('img', { src: '/img/logo.png', alt: '' }), el('div', null, [el('span', { text: site }), el('small', { text: location.host + ' ›' })])]));
      g.appendChild(el('div', { class: 't', text: title }));
      g.appendChild(el('div', { class: 'd', text: desc }));
      share.textContent = '';
      share.appendChild(el('div', null, [el('div', { class: 'img' }), el('div', { class: 'body' }, [el('b', { text: title }), el('span', { text: desc }), el('small', { text: location.host })])]));
    };
    c.mock();
  }

  function txWhere() {
    var track = $('txTrack');
    var n = tx.cards.length;
    if (!n) { $('txWhere').textContent = ''; return; }
    var w = tx.cards[0].el.offsetWidth + 16;
    var i = Math.max(0, Math.min(n - 1, Math.round(track.scrollLeft / w)));
    $('txWhere').textContent = 'Section ' + (i + 1) + ' of ' + n + ' · ' + tx.cards[i].sec.section;
    $('txPrev').disabled = i === 0;
    $('txNext').disabled = i >= n - 1;
    $$('#txDots span').forEach(function (d, j) { d.classList.toggle('on', j === i); });
    tx.at = i;
  }
  $('txTrack').addEventListener('scroll', function () { window.requestAnimationFrame(txWhere); }, { passive: true });
  function txGo(step) {
    var c = tx.cards[(tx.at || 0) + step];
    if (c) $('txTrack').scrollTo({ left: c.el.offsetLeft - $('txTrack').offsetLeft, behavior: 'smooth' });
  }
  $('txPrev').addEventListener('click', function () { txGo(-1); });
  $('txNext').addEventListener('click', function () { txGo(1); });
  $$('.tx-view button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (tx.view === b.dataset.view) return;
      tx.view = b.dataset.view;
      txRenderCards();
    });
  });

  // ---------- the edit sheet ----------
  function txInput() { return $('txInputBox').firstChild; }
  function txActive(key, scroll) {
    tx.cards.forEach(function (c) { if (c.frame && c.frame.contentWindow) txSend(c.frame.contentWindow, { rnb: 'active', key: key, scroll: !!scroll && c === tx.from }); });
  }
  function txOpen(key, fromCard) {
    var f = txField(key);
    if (!f) return;
    tx.key = key;
    tx.from = fromCard || tx.cards.filter(function (c) { return c.fields.indexOf(f) >= 0; })[0] || null;
    tx.before = txValue(f);
    $('txWhereEdit').textContent = f.page + ' · ' + f.section;
    $('txLabel').textContent = f.label;
    var box = $('txInputBox');
    box.textContent = '';
    var input;
    if (f.type === 'line') input = el('input', { type: 'text', maxlength: '200', 'aria-labelledby': 'txLabel' });
    else {
      var rows = f.type === 'list' ? Math.min(12, Math.max(4, txLines(txValue(f)).length + 1)) : f.type === 'text' ? 5 : 3;
      input = el('textarea', { rows: String(rows), maxlength: f.type === 'heading' ? '200' : '2000', 'aria-labelledby': 'txLabel' });
    }
    input.value = txValue(f);
    input.addEventListener('input', txTyped);
    box.appendChild(input);
    var hint = f.hint || (f.type === 'list' ? 'One per line.' : f.type === 'heading' ? 'A new line starts a new line on the page. Put *stars* around words to colour them.' : '');
    $('txHint').textContent = hint;
    $('txHint').hidden = !hint;
    $('txMsg').hidden = true;
    txMarkReset();
    $('txSheet').hidden = false;
    txActive(key, true);
    setTimeout(function () { input.focus(); if (input.select && f.type === 'line') input.select(); }, 60);
  }
  function txMarkReset() {
    var f = txField(tx.key);
    $('txReset').hidden = !f || txInput().value.trim() === f.default.trim();
  }
  function txTyped() {
    var f = txField(tx.key);
    var v = txInput().value;
    if (f.type === 'line') v = v.replace(/\s*\n\s*/g, ' ');
    txShowEverywhere(f, v.trim() === '' ? f.default : v);
    if (/_title$|_description$/.test(f.key) || f.key === 'site_name') {
      var keep = f.value; f.value = v; tx.cards.forEach(function (c) { if (c.mock) c.mock(); }); f.value = keep;
    }
    txMarkReset();
  }
  function txClose(saved) {
    var f = txField(tx.key);
    if (!saved && f && txInput() && txInput().value !== tx.before) {
      if (!confirm('Close without saving? The new words will be thrown away.')) return;
    }
    if (!saved && f) txShowEverywhere(f, txValue(f));
    $('txSheet').hidden = true;
    txActive(null);
    tx.key = null;
  }
  $$('#txSheet [data-close]').forEach(function (b) { b.addEventListener('click', function () { txClose(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('txSheet').hidden) txClose(false); });
  $('txReset').addEventListener('click', function () {
    var f = txField(tx.key);
    txInput().value = f.default;
    txTyped();
    txInput().focus();
  });
  $('txForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = txField(tx.key);
    var v = txInput().value;
    if (v === txValue(f)) return txClose(true);
    var btn = $('txSave');
    var body = {};
    body[f.key] = v.trim() === f.default.trim() ? '' : v;
    busy(btn, true);
    call('PUT', '/api/admin/content', body).then(function () {
      f.value = body[f.key] === '' ? '' : v.trim();
      txShowEverywhere(f, txValue(f));
      txClose(true);
      toast('Saved. It’s live on the website now.');
      // Update the "changed" counts and the word lists.
      txRenderPages();
      tx.cards.forEach(function (c) {
        txFillList(c);
        var n = c.fields.filter(function (x) { return x.value !== ''; }).length;
        var head = c.el.querySelector('.tx-card-head');
        var tag = head.querySelector('.n');
        if (n && !tag) head.appendChild(tag = el('span', { class: 'n' }));
        if (tag) { if (n) tag.textContent = n + ' changed'; else tag.remove(); }
      });
    }).catch(function (err) { say($('txMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });
  window.addEventListener('beforeunload', function (e) {
    if (!$('txSheet').hidden && txInput() && txInput().value !== tx.before) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Megaticket ----------
  function mtWhen(d) {
    d = new Date(d);
    var today = new Date().toDateString() === d.toDateString();
    return (today ? 'today' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Harare' })) +
      ' at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' });
  }
  function showMegaticket(d) {
    var box = $('mtStatus');
    var parts = [];
    var last = d.last;
    if (last) {
      parts.push('Last checked ' + mtWhen(last.at) + '.');
      if (last.error) parts.push('Megaticket could not be opened.');
      else if (last.added && last.added.length) parts.push(plural(last.added.length, 'new event') + ' added: ' + last.added.map(function (a) { return a.title; }).join(', ') + '.');
      else parts.push('Nothing new.');
    }
    if (d.next) parts.push('Next check ' + mtWhen(d.next) + '.');
    box.textContent = parts.join(' ') || 'Checks every day at 12:00 and 21:00.';
  }
  function loadMegaticket() { get('/api/admin/megaticket').then(showMegaticket).catch(function () { /* optional */ }); }
  $('mtCheck').addEventListener('click', function () {
    var btn = this;
    busy(btn, true);
    $('mtStatus').textContent = 'Looking at Megaticket…';
    call('POST', '/api/admin/megaticket/check').then(function (d) {
      showMegaticket(d);
      var n = d.last && d.last.added ? d.last.added.length : 0;
      toast(d.last && d.last.error ? d.last.error : n ? plural(n, 'new event') + ' added from Megaticket' : 'No new events on Megaticket');
      if (n) loadAll();
    }).catch(function (err) { toast(err.message); loadMegaticket(); })
      .then(function () { busy(btn, false); });
  });

  // ---------- merch shop ----------
  var shopState = { products: [], orders: [], settings: {}, filter: 'todo', open: {} };
  function dollars(c) { var v = c / 100; return '$' + (v % 1 ? v.toFixed(2) : String(v)); }
  var ORDER_WORDS = { pending: 'Waiting for payment', paid: 'Paid · to send', sent: 'Sent', delivered: 'Delivered', failed: 'Payment failed', cancelled: 'Cancelled' };
  function loadShop() {
    return Promise.all([get('/api/admin/shop'), get('/api/admin/shop/orders')]).then(function (r) {
      shopState.products = r[0].products;
      shopState.settings = r[0].settings;
      shopState.orders = r[1].orders;
      renderOrders(); renderProducts(); renderPaySettings(); shopBadge();
    }).catch(function (err) { toast(err.message); });
  }
  function shopBadge() {
    var n = shopState.orders.filter(function (o) { return o.status === 'paid'; }).length;
    $('shopBadge').hidden = !n;
    $('shopBadge').textContent = String(n);
  }
  // The badge on the tab: paid orders waiting to be sent.
  function checkOrders() { get('/api/admin/shop/orders').then(function (r) { shopState.orders = r.orders; shopBadge(); if (!document.querySelector('[data-panel="shop"]').hidden) renderOrders(); }).catch(function () {}); }
  setInterval(function () { if (!$('appView').hidden) checkOrders(); }, 60000);

  segment('orderSeg', function (v) { shopState.filter = v; renderOrders(); });
  function renderOrders() {
    var f = shopState.filter;
    var list = shopState.orders.filter(function (o) {
      if (f === 'todo') return o.status === 'paid';
      if (f === 'pending') return o.status === 'pending';
      if (f === 'done') return ['sent', 'delivered', 'cancelled', 'failed'].indexOf(o.status) >= 0;
      return true;
    });
    var box = $('orderList');
    box.textContent = '';
    if (!list.length) {
      box.appendChild(el('p', { class: 'empty', text: f === 'todo' ? 'No paid orders waiting to be sent.' : 'No orders here yet.' }));
      return;
    }
    list.forEach(function (o) {
      var row = el('div', { class: 'order-row' });
      var head = el('button', { type: 'button', 'aria-expanded': shopState.open[o.id] ? 'true' : 'false' }, [
        !o.seen && o.status === 'paid' ? el('span', { class: 'o-new', title: 'New' }) : null,
        el('span', { class: 'o-main' }, [
          el('b', { text: o.name + ' · ' + o.ref }),
          el('small', { text: fmtDate(o.created_at) + ' ' + fmtTime(o.created_at) + ' · ' + o.items.reduce(function (n, i) { return n + i.qty; }, 0) + ' item(s) · ' + (o.city || '') })
        ]),
        el('span', { class: 'o-total', text: dollars(o.total_cents) }),
        el('span', { class: 'o-status ' + o.status, text: ORDER_WORDS[o.status] || o.status })
      ]);
      head.addEventListener('click', function () { shopState.open[o.id] = !shopState.open[o.id]; renderOrders(); });
      row.appendChild(head);
      if (shopState.open[o.id]) {
        var tel = o.phone.replace(/^0/, '263');
        var actions = [];
        function act(label, status, cls, ask) {
          actions.push(el('button', { class: 'btn btn-sm ' + (cls || 'btn-light'), type: 'button', text: label, onclick: function () {
            if (ask && !confirm(ask)) return;
            call('PUT', '/api/admin/shop/orders/' + o.id, { status: status }).then(function () { toast('Order ' + o.ref + ': ' + (ORDER_WORDS[status] || status)); loadShop(); })
              .catch(function (err) { toast(err.message); });
          } }));
        }
        if (o.status === 'pending' || o.status === 'failed') act('Mark as paid', 'paid', 'btn-green', 'Mark ' + o.ref + ' as paid? Only do this once the money is in your account.');
        if (o.status === 'paid') act('Mark as sent', 'sent', 'btn-dark');
        if (o.status === 'sent') act('Mark as delivered', 'delivered', 'btn-dark');
        if (o.status !== 'cancelled' && o.status !== 'delivered') act('Cancel order', 'cancelled', 'btn-ghost', 'Cancel order ' + o.ref + '? If it was paid, refund the customer yourself.');
        row.appendChild(el('div', { class: 'o-detail' }, [
          el('div', { class: 'o-items' }, o.items.map(function (i) {
            return el('div', { text: i.qty + ' × ' + i.name + (i.size ? ' (size ' + i.size + ')' : '') + ' — ' + dollars(i.price_cents * i.qty) });
          }).concat([el('b', { text: 'Total ' + dollars(o.total_cents) })])),
          el('div', null, [el('b', { text: 'Deliver to: ' }), o.address + ', ' + o.city]),
          el('div', null, [el('b', { text: 'Phone: ' }), el('a', { href: 'tel:' + o.phone, text: o.phone, style: 'text-decoration:underline' }), ' · ',
            el('a', { href: 'https://wa.me/' + tel, target: '_blank', rel: 'noopener', text: 'WhatsApp', style: 'text-decoration:underline' })]),
          o.email ? el('div', null, [el('b', { text: 'Email: ' }), o.email]) : null,
          o.note ? el('div', null, [el('b', { text: 'Note: ' }), o.note]) : null,
          el('div', { class: 'muted' }, ['Paid with ' + (o.pay_method === 'manual' ? 'own instructions' : (o.pay_method || '')) + (o.pay_phone ? ' from ' + o.pay_phone : '') + (o.paynow_ref ? ' · Paynow ref ' + o.paynow_ref : '') + (o.error ? ' · ' + o.error : '')]),
          el('div', { class: 'btn-row', style: 'margin-top:4px' }, actions)
        ]));
      }
      box.appendChild(row);
    });
    if (shopState.orders.some(function (o) { return !o.seen; })) call('POST', '/api/admin/shop/orders/seen').catch(function () {});
  }

  // items
  function resetProductForm() {
    $('productForm').reset();
    $('pfId').value = '';
    $('pfActive').checked = true;
    $('productFormTitle').textContent = 'Add an item';
    $('pfSubmit').textContent = 'Add item';
    $('pfCancel').hidden = true;
    $('pfFilesName').textContent = 'Choose photos';
    $('pfPhotos').textContent = '';
    $('pfMsg').hidden = true;
  }
  $('pfCancel').addEventListener('click', resetProductForm);
  $('pfFiles').addEventListener('change', function () { $('pfFilesName').textContent = this.files.length ? plural(this.files.length, 'photo') + ' chosen' : 'Choose photos'; });
  function editProduct(p) {
    resetProductForm();
    $('pfId').value = p.id;
    $('pfName').value = p.name;
    $('pfPrice').value = (p.price_cents / 100).toFixed(2).replace(/\.00$/, '');
    $('pfSizes').value = p.sizes.join(', ');
    $('pfDesc').value = p.description;
    $('pfActive').checked = p.active;
    $('productFormTitle').textContent = 'Edit item';
    $('pfSubmit').textContent = 'Save item';
    $('pfCancel').hidden = false;
    p.photo_ids.forEach(function (mid) {
      $('pfPhotos').appendChild(el('span', { class: 'pf-photo', style: "background-image:url('" + media(mid, true) + "')" }, [
        el('button', { type: 'button', 'aria-label': 'Remove photo', text: '×', onclick: function (e) {
          var tile = e.currentTarget.parentNode;
          if (!confirm('Remove this photo?')) return;
          call('DELETE', '/api/admin/shop/products/' + p.id + '/photos/' + mid).then(function () { tile.remove(); loadShop(); }).catch(function (err) { toast(err.message); });
        } })
      ]));
    });
    $('productForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('productForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = $('pfId').value, btn = $('pfSubmit');
    var body = { name: $('pfName').value, price: $('pfPrice').value, sizes: $('pfSizes').value, description: $('pfDesc').value, active: $('pfActive').checked };
    var files = $('pfFiles').files;
    busy(btn, true);
    (id ? call('PUT', '/api/admin/shop/products/' + id, body).then(function () { return id; })
      : call('POST', '/api/admin/shop/products', body).then(function (r) { return r.id; }))
      .then(function (pid) {
        if (!files.length) return;
        btn.textContent = 'Uploading photos…';
        var fd = new FormData();
        Array.prototype.forEach.call(files, function (f) { fd.append('photos', f); });
        return call('POST', '/api/admin/shop/products/' + pid + '/photos', fd);
      })
      .then(function () { busy(btn, false); toast(id ? 'Item saved' : 'Item added to the shop'); resetProductForm(); loadShop(); })
      .catch(function (err) { busy(btn, false); say($('pfMsg'), err.message, false); loadShop(); });
  });
  function renderProducts() {
    var box = $('productList');
    box.textContent = '';
    if (!shopState.products.length) { box.appendChild(el('p', { class: 'empty', text: 'No items yet. Add your caps, tees and cups on the left.' })); return; }
    shopState.products.forEach(function (p) {
      box.appendChild(el('div', { class: 'p-row' + (p.active ? '' : ' off') }, [
        el('span', { class: 'p-img', style: p.photo_ids.length ? "background-image:url('" + media(p.photo_ids[0], true) + "')" : '' }),
        el('span', { class: 'p-txt' }, [el('b', { text: p.name }), el('small', { text: dollars(p.price_cents) + (p.sizes.length ? ' · ' + p.sizes.join(', ') : '') + (p.active ? '' : ' · hidden') })]),
        el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Edit', onclick: function () { editProduct(p); } }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Delete', onclick: function () {
          if (!confirm('Delete ' + p.name + ' from the shop? Past orders keep their details.')) return;
          call('DELETE', '/api/admin/shop/products/' + p.id).then(function () { toast('Item deleted'); loadShop(); }).catch(function (err) { toast(err.message); });
        } })
      ]));
    });
  }

  // payments
  function renderPaySettings() {
    var st = shopState.settings;
    $('payOpen').checked = st.open;
    $('payId').value = st.paynow_id || '';
    $('payKey').value = '';
    $('payKey').placeholder = st.paynow_key_set ? 'Saved. Paste a new key to change it' : 'Paste the key';
    $('payEmail').value = st.paynow_email || '';
    $('payManual').value = st.manual || '';
    $$('[name=payMethod]').forEach(function (c) { c.checked = st.methods.indexOf(c.value) >= 0; });
    $('payClear').hidden = !st.online;
    $('payState').textContent = st.online
      ? 'Online payments are on. Customers pay with ' + st.methods.join(' or ').replace('ecocash', 'EcoCash').replace('innbucks', 'InnBucks') + ' and orders turn "Paid" by themselves.'
      : 'Online payments are off. Orders are saved and customers see your own payment instructions below; mark orders paid by hand.';
  }
  $('payForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('paySave');
    var body = { open: $('payOpen').checked, paynow_id: $('payId').value.trim(), paynow_email: $('payEmail').value.trim(), manual: $('payManual').value,
      methods: $$('[name=payMethod]').filter(function (c) { return c.checked; }).map(function (c) { return c.value; }) };
    if ($('payKey').value.trim()) body.paynow_key = $('payKey').value.trim();
    busy(btn, true);
    call('PUT', '/api/admin/shop/settings', body).then(function () { say($('payMsg'), 'Saved.', true); return loadShop(); })
      .catch(function (err) { say($('payMsg'), err.message, false); }).then(function () { busy(btn, false); });
  });
  $('payClear').addEventListener('click', function () {
    if (!confirm('Remove the Paynow details? Online payments stop until you add them again.')) return;
    call('PUT', '/api/admin/shop/settings', { clear_paynow: true }).then(loadShop).catch(function (err) { toast(err.message); });
  });

  // ---------- start ----------
  try { $('loginEmail').value = localStorage.getItem('rnbLoginEmail') || ''; } catch (e) { /* ignore */ }
  var startTab = location.hash.slice(1);
  fetch('/api/admin/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (s) {
      if (!s.loggedIn) return showLogin();
      setMe(s);
      if (s.mustChange) return showSetPassword(false);
      showApp();
      if (['events', 'photos', 'details', 'text', 'shop', 'account'].indexOf(startTab) >= 0) goTo(startTab);
    }, showLogin);
})();

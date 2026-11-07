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

  // Every admin request goes through here. The server requires the X-RNB-Admin
  // header on changes (blocks cross-site requests).
  function call(method, url, body) {
    var opts = { method: method, headers: { 'X-RNB-Admin': '1', Accept: 'application/json' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && url !== '/api/admin/login') showLogin();
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
  function showLogin() {
    $('appView').hidden = true;
    $('loginView').hidden = false;
    setTimeout(function () { $('password').focus(); }, 50);
  }
  function showApp() {
    $('loginView').hidden = true;
    $('appView').hidden = false;
    loadAll();
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
    call('POST', '/api/admin/login', { password: $('password').value }).then(function () {
      $('password').value = '';
      $('loginMsg').hidden = true;
      showApp();
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

  function loadAll() {
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
    $('profileEmail').textContent = settings.contact_email || 'Admin';

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
          el('span', null, [el('b', { text: ev.title }), el('small', { text: ev.ticket_url ? 'Tickets on sale' : 'No ticket page yet' })])
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
    $('evPosterName').textContent = 'Choose a poster';
    $('evPosterHint').textContent = 'Shows on the event card and page';
    $('posterPreview').style.backgroundImage = '';
    renderEventGrid();
  }
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
      $('evDesc').value = ev.description;
      if (ev.cover_media_id) {
        $('evPosterName').textContent = 'Change poster';
        $('evPosterHint').textContent = 'This is the current poster';
        $('posterPreview').style.backgroundImage = "url('" + media(ev.cover_media_id, true) + "')";
      }
      renderEventGrid();
    }
    $('eventForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function () { $('evTitle').focus({ preventScroll: true }); }, 300);
  }

  $('evPoster').addEventListener('change', function () {
    var f = this.files[0];
    if (!f) return;
    $('evPosterName').textContent = f.name;
    $('evPosterHint').textContent = 'New poster, saved when you press the button below';
    $('posterPreview').style.backgroundImage = "url('" + URL.createObjectURL(f) + "')";
  });

  $('eventForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('evSubmit');
    var id = $('evId').value;
    var body = {
      title: $('evTitle').value, starts_at: $('evStart').value, venue: $('evVenue').value,
      ticket_url: $('evTicket').value, description: $('evDesc').value
    };
    var poster = $('evPoster').files[0];
    busy(btn, true);
    var save = id ? call('PUT', '/api/admin/events/' + id, body).then(function () { return id; })
      : call('POST', '/api/admin/events', body).then(function (r) { return r.id; });
    save.then(function (eventId) {
      if (!poster) return;
      btn.textContent = 'Uploading poster…';
      var fd = new FormData();
      fd.append('category', 'event');
      fd.append('event_id', eventId);
      fd.append('cover', '1');
      fd.append('photos', poster);
      return call('POST', '/api/admin/photos', fd);
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
      call('POST', '/api/admin/photos/' + id + '/replace', fd).then(function () {
        toast('Photo replaced');
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
      var replaceBtn = el('button', { type: 'button', class: 'slot-btn', text: 'Replace' });
      replaceBtn.addEventListener('click', function () { replacePhoto(item.id, slot.video ? VIDEO_TYPES : 'image/*', replaceBtn, afterSlotChange); });
      return el('div', { class: 'slot-tile' }, [
        preview,
        el('span', { class: 'slot-n', text: isVideo ? 'Video' : String(i + 1) }),
        el('div', { class: 'slot-actions' }, [
          replaceBtn,
          el('button', { type: 'button', class: 'slot-btn danger', text: 'Delete', onclick: function () {
            if (!confirm('Remove this ' + (isVideo ? 'video' : 'photo') + ' from "' + slot.label + '"?')) return;
            call('DELETE', '/api/admin/photos/' + item.id).then(function () { toast('Removed'); afterSlotChange(); }).catch(function (err) { alert(err.message); });
          } })
        ])
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
          toast(plural(r.ids.length, 'photo') + ' added to ' + slot.label);
          afterSlotChange();
        }).catch(function (err) { alert(err.message); addLabel.textContent = '+ Add photo'; input.value = ''; });
      });
      tiles.push(addTile);
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
      box.appendChild(el('p', { class: 'storage-live' }, [el('span', { class: 'live-dot' }), 'Live from your database · checked ' + new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date())]));
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

  // ---------- start ----------
  var startTab = location.hash.slice(1);
  if (['overview', 'events', 'photos', 'details'].indexOf(startTab) >= 0 && startTab !== 'overview') goTo(startTab);
  fetch('/api/admin/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (s) { if (s.loggedIn) showApp(); else showLogin(); }, showLogin);
})();

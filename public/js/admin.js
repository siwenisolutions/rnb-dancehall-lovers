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
  }

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
    b.addEventListener('click', function () { goTo('photos'); setTimeout(function () { $('photoCaption').focus(); }, 100); });
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
      get('/api/photos?limit=6')
    ]).then(function (r) {
      events = r[0].upcoming.map(function (e) { e.up = true; return e; }).concat(r[0].past);
      settings = r[2];
      renderOverview(r[1], r[3].photos);
      renderTable('overview');
      renderTable('events');
      fillSettings();
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
    $('mExperience').textContent = stats.experience;
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
    $('storageFoot').textContent = Math.round(pct) + '% of ' + Math.round(limitMb) + ' MB';

    renderChart();

    var box = $('latestPhotos');
    box.textContent = '';
    if (!latest.length) box.appendChild(el('p', { class: 'empty', text: 'No photos yet.' }));
    latest.forEach(function (p) {
      box.appendChild(el('a', { href: media(p.id), target: '_blank', rel: 'noopener', style: "background-image:url('" + media(p.id, true) + "')", 'aria-label': 'Open photo' }, [
        el('span', { text: catLabel(p.category) })
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

  // ---------- events table ----------
  var tableState = { overview: { q: '', f: '' }, events: { q: '', f: '' } };
  $$('[data-search]').forEach(function (input) {
    input.addEventListener('input', function () { tableState[input.dataset.search].q = input.value.trim().toLowerCase(); renderTable(input.dataset.search); });
  });
  $$('[data-filter]').forEach(function (sel) {
    sel.addEventListener('change', function () { tableState[sel.dataset.filter].f = sel.value; renderTable(sel.dataset.filter); });
  });

  function renderTable(key) {
    var table = document.querySelector('[data-table="' + key + '"]');
    var st = tableState[key];
    var rows = events.filter(function (e) {
      if (st.f === 'up' && !e.up) return false;
      if (st.f === 'past' && e.up) return false;
      if (st.q && (e.title + ' ' + e.venue).toLowerCase().indexOf(st.q) < 0) return false;
      return true;
    });
    if (key === 'overview') rows = rows.slice(0, 6);

    table.textContent = '';
    table.appendChild(el('thead', null, [el('tr', null, ['Event', 'Date', 'Venue', 'Photos', 'Status', ''].map(function (h) {
      return el('th', { text: h, scope: 'col' });
    }))]));
    var tbody = el('tbody');
    if (!rows.length) {
      tbody.appendChild(el('tr', null, [el('td', { colspan: '6', class: 'empty-row' }, [
        events.length ? 'No events match.' : 'No events yet. ',
        events.length ? null : el('button', { class: 'btn btn-dark btn-sm', type: 'button', text: '+ Add your first event', onclick: function () { openEventForm(null); } })
      ])]));
    }
    rows.forEach(function (ev) {
      var trigger = el('button', { class: 'dots', type: 'button', 'aria-label': 'Actions for ' + ev.title, 'aria-haspopup': 'true', 'aria-expanded': 'false', text: '•••' });
      var menu = el('div', { class: 'menu', hidden: true }, [
        el('button', { type: 'button', text: 'Edit event', onclick: function () { closeMenu(); openEventForm(ev); } }),
        el('button', { type: 'button', text: 'Manage photos', onclick: function () { closeMenu(); openEventPhotos(ev); } }),
        el('a', { href: '/events/' + ev.id, target: '_blank', rel: 'noopener', text: 'View on website' }),
        el('button', { type: 'button', text: 'Delete', style: 'color:var(--red)', onclick: function () { closeMenu(); deleteEvent(ev); } })
      ]);
      trigger.addEventListener('click', function () { toggleMenu(trigger, menu); });
      tbody.appendChild(el('tr', null, [
        el('td', null, [el('div', { class: 'ev-cell' }, [
          el('span', { class: 'ev-thumb', style: ev.cover_media_id ? "background-image:url('" + media(ev.cover_media_id, true) + "')" : '' }),
          el('span', null, [el('b', { text: ev.title }), ev.ticket_url ? el('small', { text: 'Tickets linked' }) : el('small', { text: 'No ticket link' })])
        ])]),
        el('td', null, [el('span', { text: fmtDate(ev.starts_at) }), el('br'), el('small', { class: 'muted', text: fmtTime(ev.starts_at) })]),
        el('td', { text: ev.venue || '—' }),
        el('td', null, [el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: String(ev.photo_count), title: 'Manage photos', onclick: function () { openEventPhotos(ev); } })]),
        el('td', null, [el('span', { class: 'status ' + (ev.up ? 'up' : 'past'), text: ev.up ? 'Upcoming' : 'Past' })]),
        el('td', { style: 'text-align:right' }, [el('div', { class: 'row-menu' }, [trigger, menu])])
      ]));
    });
    table.appendChild(tbody);
  }

  function deleteEvent(ev) {
    if (!confirm('Delete "' + ev.title + '" and all of its photos? This cannot be undone.')) return;
    call('DELETE', '/api/admin/events/' + ev.id).then(function () {
      toast('Event deleted');
      if (currentEvent && currentEvent.id === ev.id) closeDrawers();
      loadAll();
    }).catch(function (err) { alert(err.message); });
  }

  // ---------- drawers ----------
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

  // ---------- add / edit event ----------
  function openEventForm(ev) {
    $('eventForm').reset();
    $('evMsg').hidden = true;
    $('evId').value = ev ? ev.id : '';
    $('eventFormTitle').textContent = ev ? 'Edit event' : 'Add event';
    $('evSubmit').textContent = ev ? 'Save changes' : 'Add event';
    $('evTitle').value = ev ? ev.title : '';
    $('evStart').value = ev ? toLocalInput(ev.starts_at) : '';
    $('evVenue').value = ev ? ev.venue : '';
    $('evTicket').value = ev ? ev.ticket_url : '';
    $('evDesc').value = ev ? ev.description : '';
    $('evPosterName').textContent = ev && ev.cover_media_id ? 'Replace poster' : 'Choose a poster';
    $('evPosterHint').textContent = ev && ev.cover_media_id ? '(current poster shown)' : '(optional)';
    $('posterPreview').style.backgroundImage = ev && ev.cover_media_id ? "url('" + media(ev.cover_media_id, true) + "')" : '';
    openDrawer('eventDrawer');
    setTimeout(function () { $('evTitle').focus(); }, 260);
  }

  $('evPoster').addEventListener('change', function () {
    var f = this.files[0];
    if (!f) return;
    $('evPosterName').textContent = f.name;
    var url = URL.createObjectURL(f);
    $('posterPreview').style.backgroundImage = "url('" + url + "')";
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
      closeDrawers();
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

  function photoTile(p, opts) {
    opts = opts || {};
    var caption = el('input', { type: 'text', value: p.caption || '', maxlength: '200', placeholder: 'Add a caption', 'aria-label': 'Caption' });
    var save = el('button', { class: 'btn btn-dark btn-sm', type: 'button', text: 'Save', hidden: true, onclick: function () {
      call('PUT', '/api/admin/photos/' + p.id, { caption: caption.value }).then(function () { save.hidden = true; p.caption = caption.value; toast('Caption saved'); })
        .catch(function (err) { alert(err.message); });
    } });
    caption.addEventListener('input', function () { save.hidden = caption.value === (p.caption || ''); });
    caption.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!save.hidden) save.click(); } });
    return el('div', { class: 'ph' }, [
      el('a', { class: 'ph-img', href: media(p.id), target: '_blank', rel: 'noopener', style: "background-image:url('" + media(p.id, true) + "')", 'aria-label': 'Open full size photo' }, [
        opts.badge || (opts.showCat ? el('span', { class: 'badge cat', text: catLabel(p.category) }) : null)
      ]),
      el('div', { class: 'ph-body' }, [
        p.event_title ? el('small', { text: p.event_title }) : null,
        caption,
        el('div', { class: 'ph-btns' }, (opts.extra || []).concat([
          save,
          el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: function () {
            if (!confirm('Delete this photo from the website?')) return;
            call('DELETE', '/api/admin/photos/' + p.id).then(function () { toast('Photo deleted'); opts.onChange(); }).catch(function (err) { alert(err.message); });
          } })
        ]))
      ])
    ]);
  }

  // ---------- photos page ----------
  function segment(id, onChange) {
    var seg = $(id);
    seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        onChange(b.dataset.val);
      });
    });
  }
  var photoFilter = '';
  var photoCount = 0;
  segment('photoCatSeg', function (v) { $('photoCat').value = v; });
  segment('photoFilterSeg', function (v) { photoFilter = v; loadPhotos(true); });

  function loadPhotos(reset) {
    var grid = $('photoGrid');
    if (reset) { grid.textContent = ''; photoCount = 0; }
    get('/api/photos?limit=48&offset=' + photoCount + (photoFilter ? '&category=' + photoFilter : '')).then(function (data) {
      if (reset && !data.photos.length) grid.appendChild(el('p', { class: 'empty', text: 'No photos here yet.' }));
      data.photos.forEach(function (p) {
        grid.appendChild(photoTile(p, { showCat: true, onChange: function () { loadPhotos(true); loadAll(); } }));
      });
      photoCount += data.photos.length;
      $('photoMore').hidden = !data.more;
    }).catch(function (err) { toast(err.message); });
  }
  $('photoMore').addEventListener('click', function () { loadPhotos(false); });

  $('photoFiles').addEventListener('change', function () {
    $('photoFilesName').textContent = this.files.length ? plural(this.files.length, 'photo') + ' selected' : 'Up to 20 at a time · phone photos are fine';
  });

  $('photoForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var files = $('photoFiles').files;
    if (!files.length) { say($('photoMsg'), 'Choose photos first.', false); return; }
    uploadInBatches(files, { category: $('photoCat').value, caption: $('photoCaption').value }, $('photoSubmit')).then(function (n) {
      say($('photoMsg'), plural(n, 'photo') + ' uploaded.', true);
      $('photoFiles').value = '';
      $('photoCaption').value = '';
      $('photoFilesName').textContent = 'Up to 20 at a time · phone photos are fine';
      loadPhotos(true);
      loadAll();
    }).catch(function (err) { say($('photoMsg'), err.message, false); loadPhotos(true); });
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

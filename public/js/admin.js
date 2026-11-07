(function () {
  'use strict';

  var TZ = 'Africa/Harare';
  var $ = function (id) { return document.getElementById(id); };

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

  // All admin requests go through here. The X-RNB-Admin header is required by
  // the server for every change (protects against cross-site requests).
  function call(method, url, body) {
    var opts = { method: method, headers: { 'X-RNB-Admin': '1', Accept: 'application/json' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && url !== '/api/admin/login') { showLogin(); }
        if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
        return data;
      });
    }, function () { throw new Error('No connection. Check your internet and try again.'); });
  }

  function say(box, text, ok) {
    box.hidden = false;
    box.className = 'msg ' + (ok ? 'ok' : 'err');
    box.textContent = text;
    if (ok) setTimeout(function () { if (box.textContent === text) box.hidden = true; }, 5000);
  }

  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Saving…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function fmt(iso) {
    var d = new Date(iso);
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d) +
      ', ' + new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  }

  // ISO time -> "YYYY-MM-DDTHH:MM" in Zimbabwe time for the date picker.
  function toLocalInput(iso) {
    var parts = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }

  function media(id, thumb) { return '/media/' + id + (thumb ? '?size=thumb' : ''); }

  // ---------- login ----------
  function showLogin() { $('appView').hidden = true; $('loginView').hidden = false; $('password').focus(); }
  function showApp() { $('loginView').hidden = true; $('appView').hidden = false; loadEvents(); }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = e.submitter || this.querySelector('button');
    busy(btn, true, 'Logging in…');
    call('POST', '/api/admin/login', { password: $('password').value }).then(function () {
      $('password').value = '';
      $('loginMsg').hidden = true;
      showApp();
    }).catch(function (err) { say($('loginMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });

  $('logoutBtn').addEventListener('click', function () {
    call('POST', '/api/admin/logout').then(showLogin, showLogin);
  });

  // ---------- tabs ----------
  var loaded = {};
  document.querySelectorAll('[data-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var name = tab.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(function (t) { t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
      document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
      if (name === 'photos' && !loaded.photos) { loaded.photos = true; loadPhotos(true); }
      if (name === 'details' && !loaded.details) { loaded.details = true; loadSettings(); }
    });
  });

  // ---------- events ----------
  var events = [];

  function loadEvents() {
    return fetch('/api/events').then(function (r) { return r.json(); }).then(function (data) {
      events = data.upcoming.map(function (e) { e.up = true; return e; }).concat(data.past);
      var list = $('eventList');
      list.textContent = '';
      if (!events.length) { list.appendChild(el('p', { class: 'empty', text: 'No events yet. Add your first one above.' })); return; }
      events.forEach(function (ev) {
        list.appendChild(el('div', { class: 'ev' }, [
          el('div', { class: 'thumb', style: ev.cover_media_id ? "background-image:url('" + media(ev.cover_media_id, true) + "')" : '' }),
          el('div', { class: 'info' }, [
            el('b', null, [ev.title, el('span', { class: 'pill ' + (ev.up ? 'up' : 'past'), text: ev.up ? 'Upcoming' : 'Past', style: 'display:inline-block;margin-top:0;' })]),
            el('span', { text: fmt(ev.starts_at) + (ev.venue ? ' · ' + ev.venue : '') }),
            el('span', { text: ev.photo_count + ' photo' + (ev.photo_count === 1 ? '' : 's') })
          ]),
          el('div', { class: 'btns' }, [
            el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Edit', onclick: function () { editEvent(ev); } }),
            el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Photos', onclick: function () { openEventPhotos(ev); } }),
            el('a', { class: 'btn btn-light btn-sm', href: '/events/' + ev.id, target: '_blank', rel: 'noopener', text: 'View' }),
            el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: function () { deleteEvent(ev); } })
          ])
        ]));
      });
    }).catch(function () {
      $('eventList').textContent = 'Could not load events. Refresh the page.';
    });
  }

  function resetEventForm() {
    $('eventForm').reset();
    $('evId').value = '';
    $('eventFormTitle').textContent = 'Add an event';
    $('evPosterLabel').firstChild.textContent = 'Poster / cover photo ';
    $('evCancel').hidden = true;
  }

  function editEvent(ev) {
    $('evId').value = ev.id;
    $('evTitle').value = ev.title;
    $('evStart').value = toLocalInput(ev.starts_at);
    $('evVenue').value = ev.venue;
    $('evTicket').value = ev.ticket_url;
    $('evDesc').value = ev.description;
    $('evPoster').value = '';
    $('evPosterLabel').firstChild.textContent = 'Replace poster / cover photo ';
    $('eventFormTitle').textContent = 'Edit: ' + ev.title;
    $('evCancel').hidden = false;
    $('eventFormCard').scrollIntoView({ behavior: 'smooth' });
  }

  $('evCancel').addEventListener('click', resetEventForm);

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
      say($('evMsg'), id ? 'Event updated.' : 'Event added. It is now live on the website.', true);
      resetEventForm();
      return loadEvents();
    }).catch(function (err) { say($('evMsg'), err.message, false); loadEvents(); })
      .then(function () { busy(btn, false); });
  });

  function deleteEvent(ev) {
    if (!confirm('Delete "' + ev.title + '" and all of its photos? This cannot be undone.')) return;
    call('DELETE', '/api/admin/events/' + ev.id).then(function () {
      if (currentEvent && currentEvent.id === ev.id) $('eventPhotosCard').hidden = true;
      if ($('evId').value === String(ev.id)) resetEventForm();
      loadEvents();
    }).catch(function (err) { alert(err.message); });
  }

  // ---------- event photos ----------
  var currentEvent = null;

  function openEventPhotos(ev) {
    currentEvent = ev;
    $('eventPhotosTitle').textContent = 'Photos: ' + ev.title;
    $('eventPhotosCard').hidden = false;
    $('evPhotosMsg').hidden = true;
    $('eventPhotosCard').scrollIntoView({ behavior: 'smooth' });
    loadEventPhotos();
  }

  $('closeEventPhotos').addEventListener('click', function () { $('eventPhotosCard').hidden = true; currentEvent = null; });

  function loadEventPhotos() {
    var ev = currentEvent;
    fetch('/api/events/' + ev.id).then(function (r) { return r.json(); }).then(function (data) {
      if (currentEvent !== ev) return;
      var grid = $('eventPhotoGrid');
      grid.textContent = '';
      if (!data.photos.length) { grid.appendChild(el('p', { class: 'empty', text: 'No photos yet.' })); return; }
      data.photos.forEach(function (p) {
        var isCover = data.event.cover_media_id === p.id;
        grid.appendChild(photoTile(p, [
          isCover ? el('span', { class: 'badge', text: 'Cover' }) :
            el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Make cover', onclick: function () {
              call('POST', '/api/admin/events/' + ev.id + '/cover', { media_id: p.id }).then(function () { loadEventPhotos(); loadEvents(); })
                .catch(function (err) { alert(err.message); });
            } })
        ], function () { loadEventPhotos(); loadEvents(); }));
      });
    });
  }

  $('evPhotosUpload').addEventListener('click', function () {
    var files = $('evPhotosInput').files;
    if (!files.length) { say($('evPhotosMsg'), 'Choose photos first.', false); return; }
    var btn = this;
    uploadInBatches(files, { category: 'event', event_id: currentEvent.id }, btn).then(function (n) {
      say($('evPhotosMsg'), n + ' photo' + (n === 1 ? '' : 's') + ' added.', true);
      $('evPhotosInput').value = '';
      loadEventPhotos();
      loadEvents();
    }).catch(function (err) { say($('evPhotosMsg'), err.message, false); loadEventPhotos(); });
  });

  // Upload a few at a time so phones on slow connections don't time out.
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

  function photoTile(p, extra, onChange) {
    var caption = el('input', { type: 'text', value: p.caption || '', maxlength: '200', placeholder: 'Caption', 'aria-label': 'Caption' });
    var save = el('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Save caption', hidden: true, onclick: function () {
      call('PUT', '/api/admin/photos/' + p.id, { caption: caption.value }).then(function () { save.hidden = true; p.caption = caption.value; })
        .catch(function (err) { alert(err.message); });
    } });
    caption.addEventListener('input', function () { save.hidden = caption.value === (p.caption || ''); });
    return el('div', { class: 'ph' }, [
      el('a', { href: media(p.id), target: '_blank', rel: 'noopener' }, [el('img', { src: media(p.id, true), alt: p.caption || '', loading: 'lazy' })]),
      el('div', { class: 'p-body' }, [
        p.event_title ? el('span', { style: 'font-size:12px;color:var(--muted);font-weight:700;', text: 'Event: ' + p.event_title }) : null,
        caption,
        el('div', { class: 'p-btns' }, (extra || []).concat([
          save,
          el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: function () {
            if (!confirm('Delete this photo from the website?')) return;
            call('DELETE', '/api/admin/photos/' + p.id).then(onChange).catch(function (err) { alert(err.message); });
          } })
        ]))
      ])
    ]);
  }

  // ---------- photos tab ----------
  var photoItems = 0;

  function loadPhotos(reset) {
    var grid = $('photoGrid');
    if (reset) { grid.textContent = ''; photoItems = 0; }
    var cat = $('photoFilter').value;
    fetch('/api/photos?limit=48&offset=' + photoItems + (cat ? '&category=' + cat : '')).then(function (r) { return r.json(); }).then(function (data) {
      if (reset && !data.photos.length) grid.appendChild(el('p', { class: 'empty', text: 'No photos here yet.' }));
      data.photos.forEach(function (p) { grid.appendChild(photoTile(p, [], function () { loadPhotos(true); })); });
      photoItems += data.photos.length;
      $('photoMore').hidden = !data.more;
    });
  }

  $('photoFilter').addEventListener('change', function () { loadPhotos(true); });
  $('photoMore').addEventListener('click', function () { loadPhotos(false); });

  $('photoForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var files = $('photoFiles').files;
    if (!files.length) return;
    uploadInBatches(files, { category: $('photoCat').value, caption: $('photoCaption').value }, $('photoSubmit')).then(function (n) {
      say($('photoMsg'), n + ' photo' + (n === 1 ? '' : 's') + ' uploaded.', true);
      $('photoForm').reset();
      loadPhotos(true);
    }).catch(function (err) { say($('photoMsg'), err.message, false); loadPhotos(true); });
  });

  // ---------- settings ----------
  var settingsForm = $('settingsForm');

  function loadSettings() {
    fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
      Array.prototype.forEach.call(settingsForm.elements, function (input) {
        if (input.name && input.name in s) input.value = s[input.name];
      });
    });
  }

  settingsForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {};
    Array.prototype.forEach.call(settingsForm.elements, function (input) { if (input.name) body[input.name] = input.value; });
    var btn = $('settingsSubmit');
    busy(btn, true);
    call('PUT', '/api/admin/settings', body).then(function () { say($('settingsMsg'), 'Saved. The website is updated.', true); })
      .catch(function (err) { say($('settingsMsg'), err.message, false); })
      .then(function () { busy(btn, false); });
  });

  // ---------- start ----------
  fetch('/api/admin/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (s) { if (s.loggedIn) showApp(); else showLogin(); }, showLogin);
})();

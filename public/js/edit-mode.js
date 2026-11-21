/* Website text preview for the admin panel (loaded only with ?rnbedit=1).
 *
 * The admin panel shows each section of the real website in a frame. This
 * script, running inside that frame:
 *   - shows only the section being edited (?only=<CSS selector>),
 *   - marks every editable piece of text with a dotted outline,
 *   - tells the admin panel which text was tapped, and how tall the section is,
 *   - shows new wording live while it is being typed.
 * It changes nothing on the server; saving is done by the admin panel.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var only = params.get('only') || '';
  var parentWin = window.parent !== window ? window.parent : null;
  function post(msg) {
    if (!parentWin) return;
    msg.rnb = msg.rnb || 'info';
    parentWin.postMessage(msg, location.origin);
  }

  // ---------- look ----------
  var css = document.createElement('style');
  css.textContent = [
    '[data-rnb-k]:not(.rnb-k-box), .rnb-k-box > *{outline:2px dashed rgba(193,31,214,.75); outline-offset:3px; border-radius:4px; cursor:pointer; transition:outline-color .15s, background-color .15s;}',
    '[data-rnb-k]:not(.rnb-k-box):hover, .rnb-k-box:hover > *{outline-color:#c11fd6; outline-style:solid; background-color:rgba(193,31,214,.12);}',
    '.rnb-k-box{display:contents;}',
    '[data-rnb-k].rnb-active:not(.rnb-k-box), .rnb-k-box.rnb-active > *{outline:3px solid #c11fd6; background-color:rgba(193,31,214,.18);}',
    '[data-rnb-hide]{display:none !important;}',
    '.rnb-only header[data-site]{position:relative !important; top:auto !important;}',
    'html.rnb-only, .rnb-only body{min-height:0 !important;}',
    '.rnb-only body{padding-bottom:0 !important; overflow-x:hidden;}'
  ].join('\n');
  document.head.appendChild(css);

  // ---------- show one section ----------
  var leaves = [];
  if (only) {
    try { leaves = [].slice.call(document.querySelectorAll(only)); } catch (e) { leaves = []; }
  }
  if (leaves.length) {
    document.documentElement.classList.add('rnb-only');
    var keep = new Set();
    leaves.forEach(function (n) { for (; n && n !== document.body; n = n.parentElement) keep.add(n); });
    keep.forEach(function (n) {
      var p = n.parentElement;
      if (!p) return;
      [].forEach.call(p.children, function (c) {
        if (!keep.has(c) && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE') c.setAttribute('data-rnb-hide', '');
      });
    });
    // Space that only made sense with the rest of the page around it.
    leaves.forEach(function (n, i) {
      if (n.classList.contains('hero') || n.tagName === 'HEADER') return;
      var cs = getComputedStyle(n);
      if (parseFloat(cs.marginTop) > 0) n.style.setProperty('margin-top', i === 0 ? '0' : '24px', 'important');
      if (parseFloat(cs.paddingTop) > 32) n.style.setProperty('padding-top', '32px', 'important');
      if (parseFloat(cs.paddingBottom) > 48) n.style.setProperty('padding-bottom', '40px', 'important');
    });
  }
  // On a phone the menu hides behind the ☰ button: open it so its words show.
  if (leaves.some(function (n) { return n.tagName === 'HEADER'; })) {
    var nl = document.getElementById('navLinks'), bb = document.getElementById('burgerBtn');
    if (nl) nl.classList.add('is-open');
    if (bb) { bb.classList.add('is-open'); bb.setAttribute('aria-expanded', 'true'); }
  }
  function hidden(node) { return !!(node.closest && node.closest('[data-rnb-hide]')); }

  // ---------- words added by the page's scripts ----------
  // common.js wraps them as keywords in edit mode.
  var MARK = /([a-z0-9_]+)([\s\S]*?)/g;
  var PLAIN_PARENTS = { TITLE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, OPTION: 1 };
  function strip(v) { return v.replace(MARK, '$2').replace(/[-]/g, ''); }
  function fixText(node) {
    var v = node.nodeValue;
    if (!v || v.indexOf('') < 0) return;
    var parent = node.parentNode;
    if (!parent) return;
    if (PLAIN_PARENTS[parent.nodeName] || (parent.closest && parent.closest('svg'))) { node.nodeValue = strip(v); return; }
    var frag = document.createDocumentFragment();
    var last = 0;
    v.replace(MARK, function (m, key, words, at) {
      if (at > last) frag.appendChild(document.createTextNode(strip(v.slice(last, at))));
      var span = document.createElement('span');
      span.setAttribute('data-rnb-k', key);
      span.setAttribute('data-rnb-client', '');
      span.textContent = words;
      frag.appendChild(span);
      last = at + m.length;
      return m;
    });
    if (last < v.length) frag.appendChild(document.createTextNode(strip(v.slice(last))));
    parent.replaceChild(frag, node);
  }
  function fixAttrs(elem) {
    if (!elem.attributes) return;
    [].forEach.call(elem.attributes, function (a) {
      if (a.value.indexOf('') >= 0) elem.setAttribute(a.name, strip(a.value));
    });
  }
  function fixTree(root) {
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1) return;
    fixAttrs(root);
    root.querySelectorAll('*').forEach(fixAttrs);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(fixText);
    // Videos in hidden parts would still download: stop them.
    root.querySelectorAll('video').forEach(function (v) {
      if (hidden(v)) { v.removeAttribute('src'); v.preload = 'none'; try { v.load(); } catch (e) { /* ignore */ } }
    });
  }
  function fixTitle() { if (document.title.indexOf('') >= 0) document.title = strip(document.title); }

  fixTree(document.documentElement);
  fixTitle();
  new MutationObserver(function (list) {
    list.forEach(function (m) {
      if (m.type === 'attributes') { if (m.target.nodeType === 1) fixAttrs(m.target); }
      else if (m.type === 'characterData') fixText(m.target);
      else m.addedNodes.forEach(fixTree);
    });
    fixTitle();
    report();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });

  // ---------- taps ----------
  document.addEventListener('click', function (e) {
    var k = e.target.closest && e.target.closest('[data-rnb-k]');
    if (k) {
      e.preventDefault();
      e.stopPropagation();
      post({ rnb: 'edit', key: k.getAttribute('data-rnb-k') });
      return;
    }
    // Links would leave the preview; buttons (menu, tabs, photos) still work.
    var a = e.target.closest && e.target.closest('a[href]');
    if (a) e.preventDefault();
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);

  // ---------- size and which words are on screen ----------
  function onScreen(node) {
    if (hidden(node)) return false;
    var boxes = node.classList.contains('rnb-k-box') ? [].slice.call(node.children) : [node];
    return boxes.some(function (b) { return b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden'; });
  }
  function height() {
    if (!leaves.length) return document.documentElement.scrollHeight;
    var bottom = 0;
    var shown = leaves.concat([].slice.call(document.querySelectorAll('header[data-site], footer[data-site]')).filter(function (n) { return !hidden(n); }));
    shown.forEach(function (n) {
      var r = n.getBoundingClientRect();
      bottom = Math.max(bottom, r.bottom + window.scrollY + (parseFloat(getComputedStyle(n).marginBottom) || 0));
      // Drop-downs and other parts that stick out of their box (the phone menu).
      if (n.tagName === 'HEADER') n.querySelectorAll('*').forEach(function (c) {
        var cr = c.getBoundingClientRect();
        if (cr.height) bottom = Math.max(bottom, cr.bottom + window.scrollY);
      });
    });
    return Math.ceil(bottom) + 8;
  }
  var pending = false;
  function report() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var keys = {};
      document.querySelectorAll('[data-rnb-k]').forEach(function (n) {
        if (onScreen(n)) keys[n.getAttribute('data-rnb-k')] = 1;
      });
      post({ rnb: 'size', h: height(), keys: Object.keys(keys) });
    });
  }
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
  window.addEventListener('load', report);
  report();
  // Photos and fonts keep arriving for a while.
  var ticks = 0;
  var timer = setInterval(function () { report(); if (++ticks > 10) clearInterval(timer); }, 700);

  // ---------- messages from the admin panel ----------
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== parentWin || !e.data) return;
    var d = e.data;
    if (d.rnb === 'set') {
      document.querySelectorAll('[data-rnb-k="' + d.key + '"]').forEach(function (n) {
        if (n.hasAttribute('data-rnb-client')) n.textContent = d.text;
        else n.innerHTML = d.html; // built (and escaped) by the admin panel
      });
      report();
    } else if (d.rnb === 'active') {
      document.querySelectorAll('.rnb-active').forEach(function (n) { n.classList.remove('rnb-active'); });
      if (d.key) {
        var first = null;
        document.querySelectorAll('[data-rnb-k="' + d.key + '"]').forEach(function (n) { n.classList.add('rnb-active'); if (!first && onScreen(n)) first = n; });
        if (first && d.scroll) {
          var box = first.classList.contains('rnb-k-box') && first.firstElementChild ? first.firstElementChild : first;
          box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    } else if (d.rnb === 'ping') report();
  });
})();

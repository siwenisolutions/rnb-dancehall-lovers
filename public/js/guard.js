/* RNB Dancehall Lovers: no "view source" or "inspect" shortcuts.
   On laptops, desktops (Windows, Mac, Linux, ChromeOS) and Android, the usual ways into the page's code are switched off:
   the right-click / long-press menu ("View page source", "Inspect") and the keyboard shortcuts for viewing the source,
   the developer tools and saving the page. iPhones and iPads are left alone: they have no way to view a page's source.
   Typing, copying and pasting in text boxes still work (the menu stays on inputs and text areas).
   A deterrent only: the browser must download the code to run it, so its own menus can still open it. */
(function () {
  'use strict';
  if (typeof document === 'undefined' || window.__rnbGuard) return;
  window.__rnbGuard = true;
  var ua = navigator.userAgent || '', platform = navigator.platform || '';
  // iPhone, iPod, iPad (an iPad asks for the desktop site and says "Macintosh", but has a touch screen)
  var appleMobile = /iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad|iPod/i.test(platform) ||
    (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  if (appleMobile) return;

  var editable = function (el) {
    return Boolean(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  };
  // Right-click / long-press menu: off, except in text boxes (copy and paste)
  document.addEventListener('contextmenu', function (e) { if (!editable(e.target)) e.preventDefault(); }, true);

  document.addEventListener('keydown', function (e) {
    var k = String(e.key || '').toLowerCase(), code = e.keyCode || 0;
    var mod = e.ctrlKey || e.metaKey;
    var block =
      k === 'f12' || code === 123 ||                                                   // developer tools
      (mod && !e.shiftKey && !e.altKey && (k === 'u' || k === 's')) ||                // view source, save page
      (mod && e.shiftKey && (k === 'i' || k === 'j' || k === 'c' || k === 'k')) ||    // Windows / Linux / ChromeOS dev tools
      (e.metaKey && e.altKey && (k === 'i' || k === 'j' || k === 'c' || k === 'u' || code === 73 || code === 74 || code === 67 || code === 85));   // Mac (Option changes e.key)
    if (block) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();

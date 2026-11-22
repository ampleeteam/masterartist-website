/* CRM shell for phones: bottom sheet, More menu, and the installable app shell.
   Loaded only by admin.html. Does not cache or read customer data. */
(function (root) {
  function sheet(on) {
    document.querySelectorAll('.ix-sheet').forEach(function (el) { el.hidden = !on; });
    document.body.classList.toggle('sheet-on', !!on);
  }
  function more(on) {
    var box = document.getElementById('moreSheet');
    if (box) box.hidden = !on;
  }
  function register() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  root.ixSheet = sheet;
  root.moreSheet = more;
  if (document.readyState === 'complete') register();
  else root.addEventListener('load', register);
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* App shell only. Never caches Supabase, auth, or any API response. */
var SHELL = [
  '/admin.html',
  '/assets/crm-app.css',
  '/assets/crm-growth.js',
  '/assets/crm-shell.js',
  '/assets/crm-case.js',
  '/assets/crm-events.js',
  '/assets/crm-inbox-views.js',
  '/assets/crm-ads.js',
  '/assets/inbox.js',
  '/assets/wa-export.js',
  '/logo.svg',
  '/manifest.webmanifest'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open('ma-crm-shell-v2').then(function (cache) {
    return cache.addAll(SHELL);
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: event.data ? event.data.text() : 'New chat' }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'New chat assigned', {
    body: payload.body || 'Open the inbox to reply.',
    icon: '/logo.svg'
  }));
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (SHELL.indexOf(url.pathname) === -1) return;
  event.respondWith(fetch(event.request).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open('ma-crm-shell-v2').then(function (cache) { cache.put(event.request, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(event.request);
  }));
});

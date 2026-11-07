/* Service worker: membuat aplikasi bisa dibuka tanpa sinyal. Data keuangan TIDAK disimpan di sini. */
var CACHE = 'bamboo-v14';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  // add() per berkas: kalau satu ikon hilang/404, pemasangan tetap lanjut dan aplikasi tetap bisa offline.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // permintaan ke Google tidak disentuh
  if (req.mode === 'navigate') {                              // halaman: coba jaringan dulu (supaya versi baru langsung terpakai)
    // Hanya halaman aplikasi yang disimpan. Halaman lain (mis. folder mock) tidak boleh menimpa salinan aplikasi.
    var isApp = /(\/|index\.html)$/.test(url.pathname);
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok && isApp) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put('./index.html', copy); }); return res; }
      if (res && res.ok) return res;
      return caches.match('./index.html').then(function (hit) { return hit || res; });
    }).catch(function () { return isApp ? caches.match('./index.html') : Response.error(); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {       // berkas lain: cache dulu, diperbarui di belakang
    var net = fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});

// Notifikasi push: catatan otomatis baru dari notifikasi bank.
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Bamboo', {
    body: d.body || '', tag: d.tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow('./');
  }));
});

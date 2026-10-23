// Offline: app-bestanden uit de cache, bij een nieuwe versie het VERSIE-nummer ophogen.
const VERSIE = 'padel-uren-v9';
const BESTANDEN = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-64.png', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'lib/jspdf.umd.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSIE).then(c => c.addAll(BESTANDEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSIE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Netwerk eerst (altijd de nieuwste versie als er bereik is), anders de cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // altijd bij de server navragen, anders blijft een oude versie hangen
      .then(r => { const kopie = r.clone(); caches.open(VERSIE).then(c => c.put(e.request, kopie)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

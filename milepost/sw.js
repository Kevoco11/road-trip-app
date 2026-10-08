/* Milepost service worker: app shell offline; map tiles + fonts cached as you go. */
const V = 'milepost-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/core.js', 'js/sky.js', 'js/dtc.js', 'js/native.js', 'js/ui.js', 'js/engine.js', 'js/plan.js', 'js/intel.js', 'js/future.js', 'js/pit.js', 'js/lens.js', 'js/scene.js', 'js/vms.js', 'js/map.js', 'js/gps.js', 'js/obd.js', 'js/logger.js', 'js/drive.js', 'js/ahead.js', 'js/car.js', 'js/trip.js', 'js/app.js',
  'fonts/Barlow-400.woff2', 'fonts/Barlow-500.woff2', 'fonts/Barlow-600.woff2', 'fonts/BarlowCondensed-600.woff2', 'fonts/BarlowCondensed-700.woff2', 'fonts/BarlowCondensed-800.woff2', 'fonts/IBMPlexMono-500.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== 'tiles').map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/basemaps\.cartocdn\.com$/.test(u.hostname)) { // tiles: cache-first, bounded
    e.respondWith(caches.open('tiles').then(async (c) => { const hit = await c.match(e.request); if (hit) return hit; try { const r = await fetch(e.request); if (r.ok) { c.put(e.request, r.clone()); c.keys().then((k) => { if (k.length > 900) c.delete(k[0]); }); } return r; } catch (err) { return hit || Response.error(); } }));
    return;
  }
  if (u.origin === location.origin) e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); } return r; })));
});

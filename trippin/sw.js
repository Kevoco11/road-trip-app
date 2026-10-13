/* Trippin' service worker: app shell offline; map tiles + fonts cached as you go. */
const V = 'trippin-v5';
// Map tiles and scenery tiles live in their own bounded caches. 'tiles' (v3 and older) was full of CARTO's
// "API KEY REQUIRED" placeholder images, so it is retired by name and rebuilt from the new provider.
const TILE_CACHE = 'tiles-esri-v1', SCENERY_CACHE = 'scenery-v1';
const TILE_HOSTS = [[/^server\.arcgisonline\.com$/, TILE_CACHE, 900], [/^tiles\.openfreemap\.org$/, SCENERY_CACHE, 600]];
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/diag.js', 'js/core.js', 'js/sky.js', 'js/dtc.js', 'js/native.js', 'js/ui.js', 'js/engine.js', 'js/plan.js', 'js/intel.js', 'js/voice.js', 'js/future.js', 'js/pit.js', 'js/lens.js', 'js/mvt.js', 'js/path.js', 'js/world.js', 'js/terrain.js', 'js/freeroad.js','js/glscene.js', 'js/scene.js', 'js/vms.js', 'js/map.js', 'js/gps.js', 'js/obd.js', 'js/logger.js', 'js/drive.js', 'js/ahead.js', 'js/car.js', 'js/pilot.js', 'js/hud.js', 'js/recap.js', 'js/trip.js', 'js/app.js',
  'fonts/Barlow-400.woff2', 'fonts/Barlow-500.woff2', 'fonts/Barlow-600.woff2', 'fonts/BarlowCondensed-600.woff2', 'fonts/BarlowCondensed-700.woff2', 'fonts/BarlowCondensed-800.woff2', 'fonts/IBMPlexMono-500.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== TILE_CACHE && k !== SCENERY_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const tile = TILE_HOSTS.find((t) => t[0].test(u.hostname));
  if (tile && tile[1] === SCENERY_CACHE && u.pathname === '/planet') { // the TileJSON names the current data version: network-first, cached copy only when offline
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(SCENERY_CACHE).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.open(SCENERY_CACHE).then((c) => c.match(e.request)).then((hit) => hit || Response.error())));
    return;
  }
  if (tile) { // map / scenery tiles: cache-first, bounded
    const [, name, max] = tile;
    e.respondWith(caches.open(name).then(async (c) => { const hit = await c.match(e.request); if (hit) return hit; try { const r = await fetch(e.request); if (r.ok) { c.put(e.request, r.clone()); c.keys().then((k) => { if (k.length > max) c.delete(k[0]); }); } return r; } catch (err) { return hit || Response.error(); } }));
    return;
  }
  if (u.origin === location.origin) e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); } return r; })));
});

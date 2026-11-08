// Service worker: makes the quiz installable and usable offline.
// - The app page is fetched network-first, so a new deploy reaches users on their next open;
//   when there is no connection the cached copy is served.
// - Icons, the manifest and the topography pictures are precached; Google Fonts are cached the first time they load.
// - The leaderboard API (/api/) is never cached: it always goes to the network.
// Bump VERSION when the list of precached files changes.
const VERSION = 'v3'; // v3: topography pictures for the picture questions
const APP = 'bahad-app-' + VERSION;
const FONTS = 'bahad-fonts';
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/img/topo/kipa_map.jpg',
  '/img/topo/kipa_3d.jpg',
  '/img/topo/kipa_smuya_map.jpg',
  '/img/topo/ukaf_map.jpg',
  '/img/topo/ukaf_3d.jpg',
  '/img/topo/shluha_map.jpg',
  '/img/topo/shluha_3d.jpg',
  '/img/topo/gai_map.jpg',
  '/img/topo/gai_3d.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network first, falling back to the cache; a slow network falls back after 4 seconds
async function networkFirst(req, cacheKey) {
  const cache = await caches.open(APP);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(cacheKey || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey || req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // every page load (/, /?source=pwa, /index.html) is the same single page
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/'));
    return;
  }
  e.respondWith(networkFirst(req));
});

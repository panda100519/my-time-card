const CACHE_NAME = 'my-time-card-v5';
const APP_VERSION = '2.4.0';
const APP_SHELL = ['./', './index.html', './styles.css', `./app.js?v=${APP_VERSION}`, './manifest.webmanifest', './icon.svg', './icon-180.png']
  .map(path => new URL(path, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const isFreshResource = request.mode === 'navigate' || url.pathname.endsWith('/app.js');
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (isFreshResource) {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch (_) {
        const cached = await cache.match(request);
        if (cached) return cached;
        return (await cache.match(new URL('./index.html', self.registration.scope).href)) || Response.error();
      }
    }

    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (_) {
      return (await cache.match(new URL('./index.html', self.registration.scope).href)) || Response.error();
    }
  })());
});


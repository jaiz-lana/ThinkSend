const CACHE_NAME = 'thinksend-v3';
const CORE_ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(CORE_ASSETS.map((asset) => new Request(asset, { cache: 'reload' })))
      )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      const oldKeys = keys.filter((k) => k !== CACHE_NAME);
      await Promise.all(oldKeys.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (oldKeys.length > 0) {
        const windowClients = await self.clients.matchAll({ type: 'window' });
        await Promise.all(
          windowClients.map((client) => client.navigate(client.url).catch(() => {}))
        );
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  const isHtmlOrCore =
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname.endsWith('/icon.svg');

  if (isHtmlOrCore) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(event.request)
            .then(
              (cached) =>
                cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined)
            )
        )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

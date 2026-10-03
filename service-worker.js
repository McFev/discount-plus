const staticCacheName = 'static-cache-discount-plus-v1_0_5';
const dynamicCacheName = 'dynamic-cache-discount-plus-v1_0_5';

const staticAssets = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './site.webmanifest',
  './bwip-js-min.js',
  './images/icons/apple-touch-icon.png',
  './images/icons/web-app-manifest-192x192.png',
  './images/icons/web-app-manifest-512x512.png'
];

self.addEventListener('install', async event => {
  const cache = await caches.open(staticCacheName);
  await cache.addAll(staticAssets);
  console.log('Service worker has been installed');
});

self.addEventListener('activate', async event => {
  const cachesKeys = await caches.keys();
  const checkKeys = cachesKeys.map(async key => {
    if (![staticCacheName, dynamicCacheName].includes(key)) {
      await caches.delete(key);
    }
  });
  await Promise.all(checkKeys);
  console.log('Service worker has been activated');
});

self.addEventListener('fetch', event => {
  console.log(`Trying to fetch ${event.request.url}`);
  event.respondWith(checkCache(event.request));
});

async function checkCache(req) {
  const cachedResponse = await caches.match(req);
  return cachedResponse || checkOnline(req);
}

async function checkOnline(req) {
  const cache = await caches.open(dynamicCacheName);
  try {
    const res = await fetch(req);
    await cache.put(req, res.clone());
    return res;
  } catch (error) {
    const cachedRes = await cache.match(req);
    if (cachedRes) {
      return cachedRes;
    } else if (req.url.indexOf('.html') !== -1) {
      return caches.match('./index.html');
    } else {
      return caches.match('./images/no-image.png');
    }
  }
}

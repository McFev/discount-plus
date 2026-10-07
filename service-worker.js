const staticCacheName = 'static-cache-discount-plus-v1_0_7';
const dynamicCacheName = 'dynamic-cache-discount-plus-v1_0_7';

// Файлы, необходимые приложению для полноценной работы без интернета
const staticAssets = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './site.webmanifest',
  './bwip-js-min.js',
  './favicon-96x96.png',
  './favicon.svg',
  './favicon.ico',
  './images/no-image.png',
  './images/icons/apple-touch-icon.png',
  './images/icons/web-app-manifest-192x192.png',
  './images/icons/web-app-manifest-512x512.png'
];

self.addEventListener('install', event => {
  // waitUntil не даёт браузеру завершить worker, пока не закончится кэширование
  event.waitUntil((async () => {
    const cache = await caches.open(staticCacheName);
    await cache.addAll(staticAssets);
    // Новый service worker вступает в силу сразу, не дожидаясь закрытия вкладок
    await self.skipWaiting();
    console.log('Service worker has been installed');
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cachesKeys = await caches.keys();
    const checkKeys = cachesKeys.map(async key => {
      if (![staticCacheName, dynamicCacheName].includes(key)) {
        await caches.delete(key);
      }
    });
    await Promise.all(checkKeys);
    // Сразу перехватываем обработку запросов во всех открытых вкладках
    await self.clients.claim();
    console.log('Service worker has been activated');
  })());
});

self.addEventListener('fetch', event => {
  console.log(`Trying to fetch ${event.request.url}`);

  // Не-GET запросы (POST и т.п.) не кэшируются — уходят в сеть как есть
  if (event.request.method !== 'GET') return;

  event.respondWith(handleRequest(event.request));
});

async function handleRequest(req) {
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  // Собственные файлы приложения: мгновенно из кэша (работает офлайн),
  // при отсутствии в кэше — скачиваем и сохраняем в динамический кэш
  if (sameOrigin) {
    const cachedResponse = await caches.match(req);
    if (cachedResponse) return cachedResponse;

    try {
      return await saveToCache(req);
    } catch (error) {
      // Офлайн, а файла нет в кэше: для страницы отдаём index.html,
      // для картинок — заглушку
      if (req.mode === 'navigate') {
        return caches.match('./index.html');
      }
      if (req.destination === 'image') {
        return caches.match('./images/no-image.png');
      }
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  }

  // Сторонние ресурсы (например, JSON с картами по ссылке): сначала сеть,
  // чтобы не отдать устаревшие данные из кэша; офлайн — сохранённая копия
  try {
    return await saveToCache(req);
  } catch (error) {
    const cachedRes = await caches.match(req);
    if (cachedRes) return cachedRes;
    if (req.destination === 'image') {
      return caches.match('./images/no-image.png');
    }
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// Загрузка из сети с сохранением ответа в динамический кэш
async function saveToCache(req) {
  const res = await fetch(req);
  // Кэшируем только успешные ответы (opaque — успешный кросс-доменный ответ)
  if (res && (res.ok || res.type === 'opaque')) {
    const cache = await caches.open(dynamicCacheName);
    await cache.put(req, res.clone());
  }
  return res;
}

// Bump a versão sempre que fizer deploy — invalida o cache antigo.
const CACHE = 'cifras-v17';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/transposer.js',
  './js/data.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Estratégia:
// - HTML/JS/CSS/Manifest: network-first (sempre pega versão nova quando online)
// - Ícones e outros: cache-first
// - Requisições ao Apps Script: sempre network (bypass do cache)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Não interferir em chamadas para a nuvem
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com') ||
      url.hostname.includes('allorigins.win') ||
      url.hostname.includes('corsproxy.io') ||
      url.hostname.includes('codetabs.com') ||
      url.hostname.includes('cifraclub.com.br')) {
    return; // deixa o browser lidar sem passar pelo cache
  }

  const isAppShell = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/');

  if (isAppShell) {
    // network-first: pega novo, cai pro cache se offline
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
  } else {
    // cache-first para ícones/assets
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});

/* FinAnaliz service worker
   - Sayfa (HTML): once ag, ag yoksa onbellek -> internet olmadan da acilir
   - JS/CSS/ikonlar: once onbellek (Vite dosya adlari surum icerir, guvenli)
   Yeni surum yayinlandiginda CACHE adini degistirmek yeterli. */
const CACHE = 'finanaliz-v6';
const CORE = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // sunucu fonksiyonlari (yapay zeka) hic onbelleklenmez

  // Sayfa gezinmeleri: once ag, olmazsa onbellekteki uygulama kabugu
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Derlenmis dosyalar ve ikonlar: once onbellek, yoksa agdan alip sakla
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy).then(() => trimAssets(c)));
        }
        return res;
      });
    })
  );
});

// Eski surumlerden kalan derlenmis dosyalari sinirla (en yeni 16 dosya kalir)
function trimAssets(cache) {
  return cache.keys().then((keys) => {
    const assets = keys.filter((k) => new URL(k.url).pathname.startsWith('/assets/'));
    return Promise.all(assets.slice(0, Math.max(0, assets.length - 16)).map((k) => cache.delete(k)));
  });
}

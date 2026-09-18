const CACHE = 'dayflow-v20';
const STATIC = [
  './',
  './index.html',
  './dayflow1_0.html',
  './manifest.json',
  './icons/icon-180.png',
  './icons/check-mark.png',
  './css/tokens.css',
  './css/base.css',
  './css/screens.css',
  './css/desktop.css',
  './js/utils.js',
  './js/state.js',
  './js/sync.js',
  './js/auth.js',
  './js/plan.js',
  './js/oggi.js',
  './js/calendario.js',
  './js/discover.js',
  './js/settings.js',
  './js/app.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // addAll fails silently per singolo asset mancante
      Promise.allSettled(STATIC.map(url => c.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Supabase e Gemini → sempre network (dati real-time / POST), niente cache
  // NB: Gemini va gestito PRIMA della regola googleapis.com, altrimenti cache.put su una POST lancia errore
  if (url.hostname.includes('supabase.co') || url.hostname === 'generativelanguage.googleapis.com') {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Font Google e CDN → stale-while-revalidate
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com') || url.hostname.includes('jsdelivr.net')) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const cached = await c.match(e.request);
        const fresh = fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; }).catch(() => null);
        return cached || fresh;
      })
    );
    return;
  }

  // Asset dell'app (HTML, CSS, JS, manifest, icone) → cache-first versionata
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

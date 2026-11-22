// Service worker : l'application s'ouvre même hors ligne (avec les dernières données en cache).
const VERSION = "aa-v15";
const SHELL = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/store.js",
  "./js/data.js",
  "./js/indicators.js",
  "./js/sentiment.js",
  "./js/i18n.js",
  "./js/advisor.js",
  "./js/ai.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Fichiers de l'appli : réseau d'abord (pour les mises à jour), cache en secours.
// Appels aux API de données / IA : jamais interceptés.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache" }) // toujours revalider : pas de vieux code servi par le cache HTTP
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))),
  );
});

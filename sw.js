// GeneCodex offline support: keeps the app's own files on the device so it opens with no internet.
// Change VERSION whenever any app file changes, so devices pick up the new copy.
const VERSION = "genecodex-17";
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "img/icon-180.png", "img/icon-192.png", "img/icon-512.png", "img/logo.png",
  "fonts/merriweather-400.woff2", "fonts/merriweather-400-italic.woff2", "fonts/merriweather-700.woff2", "fonts/source-sans-3.woff2", "fonts/source-sans-3-italic.woff2"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so an update shows when online), the saved copy when offline.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // "no-cache": always ask the site for the newest copy when online (the site lets browsers reuse a copy for 10 minutes otherwise).
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});

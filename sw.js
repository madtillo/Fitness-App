/* Offline-Betrieb: App-Dateien werden auf dem Gerät zwischengespeichert.
   Open-Food-Facts-Anfragen gehen immer direkt ins Netz (Produkte speichert die App selbst). */
const CACHE = "tills-fitness-v2";
const SHELL = [
  "./", "index.html", "manifest.webmanifest",
  "app-extra.css", "localdb.js", "nutrition.js", "scan.js", "app.js",
  "barcode-detector-ponyfill.js", "zxing_reader.wasm",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("openfoodfacts.org") && url.pathname.startsWith("/api/")) return; // nie aus dem Cache
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;
  // App-Dateien: zuerst Cache (schnell + offline), im Hintergrund aktualisiert der Service Worker beim nächsten Update.
  e.respondWith(caches.match(e.request, { ignoreSearch: sameOrigin }).then((hit) => {
    if (hit) return hit;
    return fetch(e.request).then((res) => {
      if (res && (res.ok || res.type === "opaque") && (isFont || sameOrigin)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()));
  }));
});

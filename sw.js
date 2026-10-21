/* Offline-Betrieb: App-Dateien werden auf dem Gerät zwischengespeichert.
   Strategie „zuerst Netz“: Mit Internet lädt die App immer die aktuelle Version,
   ohne Internet die zuletzt gespeicherte. Open-Food-Facts-Anfragen gehen nie über den Cache. */
const CACHE = "tills-fitness-v14";
const SHELL = [
  "./", "index.html", "manifest.webmanifest",
  "app-extra.css", "localdb.js", "nutrition.js", "scan.js", "app.js", "docs.js", "photo.js", "recipes.js",
  "barcode-detector-ponyfill.js", "zxing_reader.wasm",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"
];
const OPTIONAL = ["bls.js", "recipes-data.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))
    // Optionale Dateien (z. B. Nährwert-Datenbank): fehlen sie, scheitert die Installation nicht
    .then(() => Promise.all(OPTIONAL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("openfoodfacts.org") || url.hostname.endsWith("googleapis.com") && !url.hostname.startsWith("fonts")) return;
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;
  // Große Scanner-Datei ändert sich nie → aus dem Cache (schnell, spart Daten)
  if (sameOrigin && url.pathname.endsWith(".wasm")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request, sameOrigin ? { cache: "no-cache" } : undefined).then((res) => {
      if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});

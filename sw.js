/*
  sw.js — the "service worker".

  A service worker is a small script the browser runs in the background,
  separate from the page. Ours keeps a copy of the app's files so the app
  opens even without internet. Strategy "network first": try the internet
  for the newest file; if you're offline, use the saved copy.
*/

// Change this name (v1 -> v2 ...) whenever you change the app's files,
// so phones throw away the old saved copy.
const CACHE_NAME = "telematics-v3";

const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./js/util.js",
  "./js/db.js",
  "./js/sensors.js",
  "./js/charts.js",
  "./js/recorder.js",
  "./js/trip-math.js",
  "./js/trip.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./fonts/barlow-400.woff2",
  "./fonts/barlow-700.woff2",
  "./fonts/roboto-mono-400.woff2",
];

// "install": runs once when the service worker is set up — save all files.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

// "activate": delete caches from older versions.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// "fetch": runs every time the app asks for a file.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((cached) => cached || caches.match("./index.html")))
  );
});

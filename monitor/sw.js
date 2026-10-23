// Sentinel Monitor service worker — caches the APP SHELL ONLY.
//
// Never cached: Firestore, Firebase Auth/Identity Toolkit, Cloud Functions or any
// other request. Readings are private and always come live from the cloud with the
// user's token; when offline the page says so instead of showing stored data.
// The cache below holds only public static files (same for every visitor), so
// nothing in it can expose one user's data to another or survive sign-out.
const VERSION = "mon-20261023-1";
const SHELL = [
  "./", "./index.html", "./monitor.css", "./monitor.js", "./status.js", "./chart.js", "./manifest.webmanifest",
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/apple-touch-icon.png",
  "../css/styles.css", "../css/hub-dashboard.css", "../js/hub-dashboard-core.js",
  "../app/org-dashboard.js", "../app/firebase-config.js",
];
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));
// Pinned public Firebase SDK files (versioned URLs; safe to cache).
const SDK = /^https:\/\/www\.gstatic\.com\/firebasejs\/\d+\.\d+\.\d+\/firebase-(app|auth|firestore)\.js$/;

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mon-") && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keyOf = (url) => url.origin + url.pathname; // ignore ?v= cache-busters

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (SDK.test(req.url)) {
    ev.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req.url, res.clone());
      return res;
    }));
    return;
  }

  const isShell = url.origin === self.location.origin &&
    (SHELL_PATHS.has(url.pathname) || (req.mode === "navigate" && url.pathname.startsWith(new URL(self.registration.scope).pathname)));
  if (!isShell) return; // everything else goes straight to the network, uncached

  // Network first so updates show up immediately; the cached shell is the offline fallback.
  ev.respondWith((async () => {
    const c = await caches.open(VERSION);
    const key = req.mode === "navigate" ? keyOf(new URL("./", self.registration.scope)) : keyOf(url);
    try {
      const res = await fetch(req, {cache: "no-cache"});
      if (res.ok && res.type === "basic" && !res.headers.has("set-cookie")) c.put(key, res.clone());
      return res;
    } catch (e) {
      const hit = await c.match(key);
      if (hit) return hit;
      throw e;
    }
  })());
});

// The page posts this on sign-out. The shell cache holds no private data, but
// drop and rebuild it anyway so a shared phone starts from a clean slate.
self.addEventListener("message", (ev) => {
  if (ev.data && ev.data.type === "signed-out") {
    ev.waitUntil(caches.delete(VERSION).then(() => caches.open(VERSION)).then((c) => c.addAll(SHELL)).catch(() => {}));
  }
});

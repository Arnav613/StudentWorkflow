/*
 * The service worker. Hand-written, and short on purpose.
 *
 * It exists for two reasons and no others:
 *
 *   1. A phone that has the app on its home screen should paint something
 *      instantly, on a metro platform with two bars of signal, rather than
 *      showing a white rectangle while Vercel is reached.
 *   2. Push. A web push notification is delivered to a service worker or it
 *      is not delivered at all — there is nowhere else to receive it.
 *
 * It is emphatically *not* an offline data layer. Nothing here caches a
 * Supabase response. The app is a deadline tracker, and a stale deadline
 * shown confidently is worse than a spinner: the failure mode of caching
 * `tasks` is that you look at your phone, see nothing due, and miss a
 * submission. So the shell is cached and the data never is.
 *
 * NOTE: this file is served from /public, so it is not processed by Vite and
 * gets no bundling, no TypeScript and no import of anything in src/. That is
 * the trade for having no build plugin in the way; keep it plain and keep it
 * dependency-free.
 */

/*
 * Bumping this string is what retires the old cache. It is deliberately
 * manual: the build filename-hashes its own assets, so the only thing that
 * ever needs a deliberate flush is this file's own idea of the shell.
 */
const CACHE = "shell-v1";

/*
 * What is worth having before it is asked for. Only the entry document and
 * the icons — the hashed JS and CSS are not listed because their names change
 * every build, and a precache list that has to be regenerated per deploy is
 * the thing a build plugin exists to do. They get cached on first use below
 * instead, which reaches the same place one load later and cannot go stale.
 */
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, not addAll: addAll is atomic, so one 404 among the
      // icons would abandon the whole precache and leave the worker
      // installed with nothing in it.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      // Don't wait for every tab to close. A shell update that only lands
      // after the user quits the app is an update they never get.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  // The page's "reload for the new version" prompt, answered.
  if (event.data === "skip-waiting") self.skipWaiting();
});

/*
 * One rule per kind of request, and a default of "don't interfere".
 *
 * Anything cross-origin is left entirely alone — that is Supabase, the API on
 * Render, Google's fonts. Intercepting those buys nothing and risks turning a
 * clear network error into a confusing cached one.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * Navigations: network first, shell second.
   *
   * Network first rather than cache first because a deploy must be visible on
   * the next open, not the one after. The cached index.html is the fallback
   * for the offline case, and because the app is a single page served for
   * every path, it is the right answer for any route.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || Response.error())),
    );
    return;
  }

  /*
   * Build assets: cache first.
   *
   * Safe precisely because Vite hashes their filenames — /assets/index-a1b2.js
   * is immutable, so a hit can never be stale, and a new deploy asks for new
   * names that miss and get fetched. This is what makes the second launch
   * instant.
   */
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

/* -------------------------------------------------------------------------
 * Push
 * ---------------------------------------------------------------------- */

/*
 * The payload is JSON written by the backend's digest job. It is read
 * defensively anyway: a push event that throws leaves the browser to show its
 * own "This site has been updated in the background" notification, which is
 * both alarming and useless, and on some platforms repeated failures revoke
 * the subscription.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "Student Dashboard";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    // Android's small monochrome status-bar mark. Falls back to a generic dot
    // if absent, which is legible but anonymous.
    badge: "/icons/badge-72.png",
    // A tag means the morning digest replaces yesterday's rather than
    // stacking: the notification shade should hold today's answer, not a
    // history of every morning this term.
    tag: data.tag || "digest",
    renotify: true,
    data: { url: data.url || "/#/week" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/*
 * Tapping the notification should land in the app that is already open, if
 * one is — a second window of a single-page app is never what was wanted.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/#/week";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin) {
          // navigate() rejects on some browsers for a hash-only change; the
          // focus is the part that matters, so failure here is swallowed.
          return client.focus().then((c) => (c.navigate ? c.navigate(target).catch(() => c) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

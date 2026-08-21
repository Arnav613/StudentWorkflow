/**
 * Installing the service worker, and knowing when we are running as an app.
 *
 * Kept apart from `lib/push.ts`: this file is about the shell — registration,
 * updates, and the one question the UI actually asks ("are we standalone?").
 * Push is a separate concern that happens to need the same worker.
 */

import { toast } from "./toast";

/**
 * Register once, after load.
 *
 * After, not during: registration kicks off a fetch of sw.js and, on a first
 * visit, a precache of the shell. On a phone on college wifi that competes
 * with the JS and the first Supabase round trip for the same few hundred
 * kilobits, and the point of the worker is the *second* launch. Nothing is
 * lost by letting the first one finish first.
 *
 * Silent by design. A failure here means the app is a website today instead
 * of an app, which is not something to interrupt anyone about — Safari in
 * private browsing refuses registration outright, and that is a normal
 * afternoon, not a bug.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // Vite serves /public at the root in dev too, but a worker registered
  // against the dev server caches module URLs that die with the session and
  // then have to be manually evicted. Registering only in the built app is
  // the difference between "the shell is cached" and an hour spent wondering
  // why an edit doesn't show up.
  if (import.meta.env.DEV) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* No worker. The app still works; it is just a website today. */
    });
  });

  /*
   * A new worker took over mid-session.
   *
   * It is told about rather than acted on. The worker calls skipWaiting on
   * install, so a deploy activates straight away — but the page that is open
   * is still running the old bundle, and reloading it out from under someone
   * mid-sentence in a note is worse than being one version behind for the
   * rest of the session. The next launch is the new version; this is a
   * receipt, not a prompt.
   *
   * The `controller` guard is what keeps it quiet on a first visit, where the
   * first worker taking control is not an update at all.
   */
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      toast("Updated — the new version loads next time you open the app");
    });
  }
}

/**
 * Running from the home screen rather than in a browser tab.
 *
 * Two checks because the platforms disagree: `display-mode: standalone` is
 * the standard and works everywhere except iOS Safari, which has its own
 * non-standard `navigator.standalone` and has never implemented the other.
 *
 * This matters for more than cosmetics — iOS grants Notification permission
 * *only* to an installed PWA, so the answer decides whether the app offers
 * reminders or explains how to make them possible.
 */
export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Non-standard, iOS only, and absent from the type definitions.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS or iPadOS, including the iPad that reports itself as a Mac with a touchscreen. */
export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

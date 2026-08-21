/**
 * Turning notification permission into a row the backend can push to.
 *
 * The browser side of web push is four steps that each fail differently, and
 * the whole of this file's job is to make the difference legible to the UI —
 * "your browser can't", "you said no once and the prompt won't come back",
 * "install it to the home screen first" are three different sentences, and
 * showing the wrong one sends someone hunting through the wrong settings
 * screen.
 */

import { api } from "./api";
import { isIOS, isStandalone } from "./pwa";

/** Where a device stands, and what the UI should therefore offer. */
export type PushState =
  /** No service worker, or no Push API. Nothing to offer. */
  | { kind: "unsupported" }
  /**
   * iOS, in a browser tab. Safari exposes the Push API only to an installed
   * PWA — asking for permission here throws rather than prompting, so the
   * only useful thing to show is the Add to Home Screen instruction.
   */
  | { kind: "needs-install" }
  /** Available, not yet asked for. */
  | { kind: "off" }
  /** Subscribed on this device. */
  | { kind: "on" }
  /**
   * Permission was refused. Worth its own state because there is no second
   * prompt: the browser will not ask again, and the fix is in site settings,
   * which the page cannot open.
   */
  | { kind: "blocked" };

/**
 * The applicationServerKey has to be the raw key bytes; the server sends the
 * base64url text that everything else in web push uses.
 *
 * The buffer is allocated first and the view taken over it, rather than the
 * shorter `Uint8Array.from`, only to pin the type: since TypeScript 5.7 a
 * plain Uint8Array is generic over ArrayBufferLike, which includes
 * SharedArrayBuffer, and `subscribe()` accepts nothing shared.
 */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** A subscription's keys, base64url, as the backend's flat row wants them. */
function unpack(sub: PushSubscription) {
  const json = sub.toJSON();
  const keys = json.keys ?? {};
  if (!keys.p256dh || !keys.auth) {
    throw new Error("The browser returned a subscription with no keys");
  }
  return {
    endpoint: sub.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    // Where this device thinks it is. The digest is sent at 8am local, and
    // this is the only place that knows what local means.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
  };
}

/** What this device can do right now, without prompting for anything. */
export async function currentState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // On iOS this is the un-installed case, and the instruction is specific
    // enough to be worth separating from "your browser cannot do this".
    return isIOS() && !isStandalone() ? { kind: "needs-install" } : { kind: "unsupported" };
  }
  if (Notification.permission === "denied") return { kind: "blocked" };

  // Ask the worker, not our own storage. The subscription lives in the
  // browser and can be revoked from settings without telling the page, so
  // anything we remembered is a guess and this is the fact.
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  return existing ? { kind: "on" } : { kind: "off" };
}

/**
 * Ask for permission, subscribe, and register the device with the backend.
 *
 * Must be called from a user gesture — browsers refuse a permission prompt
 * raised by anything else, and Safari throws rather than returning "default".
 * Hence a button, and hence no attempt to do this automatically on first load
 * however tempting that is: a prompt nobody asked for is usually answered
 * "block", and that answer is close to permanent.
 */
export async function enable(): Promise<PushState> {
  const state = await currentState();
  if (state.kind === "unsupported" || state.kind === "needs-install" || state.kind === "blocked") {
    return state;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? { kind: "blocked" } : { kind: "off" };
  }

  const reg = await navigator.serviceWorker.ready;

  // The key comes from the server rather than from a build-time variable, so
  // there is exactly one copy of it and it cannot drift out of step with the
  // private half. See the note on GET /push/key.
  const { key } = await api<{ key: string }>("/push/key");

  /*
   * Reuse an existing subscription if there is one. Calling subscribe() again
   * with the same key returns the same subscription; calling it with a
   * *different* key throws InvalidStateError rather than replacing it, which
   * is the failure a rotated VAPID key produces. Unsubscribing first costs
   * nothing when there is nothing to unsubscribe.
   */
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe().catch(() => {});

  const sub = await reg.pushManager.subscribe({
    // Non-negotiable in Chrome: a subscription that could deliver a silent
    // background message is refused outright. Every push this app sends shows
    // a notification anyway.
    userVisibleOnly: true,
    applicationServerKey: decodeKey(key),
  });

  await api("/push/subscribe", { method: "POST", body: JSON.stringify(unpack(sub)) });
  return { kind: "on" };
}

/**
 * Stop notifications on this device.
 *
 * Both halves, and the browser's half first: if the backend call fails, a
 * device that has already unsubscribed is merely a row that the next digest
 * finds dead and deletes. The reverse order would leave a device that keeps
 * ringing after the user turned it off, which is the failure that matters.
 */
export async function disable(): Promise<PushState> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { kind: "off" };

  const row = unpack(sub);
  await sub.unsubscribe().catch(() => {});
  await api("/push/unsubscribe", { method: "POST", body: JSON.stringify(row) }).catch(() => {
    /* The row is now unreachable; the digest job will clean it up on the
       first 410 from the push service. */
  });
  return { kind: "off" };
}

/** Send today's real digest now, so "did that work?" has an answer today. */
export async function sendTest(): Promise<{ sent: number; skipped_nothing_due: number }> {
  return api("/push/test", { method: "POST" });
}

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * Debounced autosave with a ceiling.
 *
 * A note has no Save button, which means the only honest way to run this is
 * to make "your work is safe" true rather than merely likely. Three rules do
 * that, and each exists because the obvious version is wrong without it:
 *
 *  - **Debounce**, so a paragraph is one write and not forty.
 *  - **A maximum wait**, because a plain debounce on someone typing steadily
 *    for four minutes never fires once. The ceiling bounds how much work a
 *    closed laptop can cost you, no matter how fast anyone types.
 *  - **A flush**, called when a note is closed or the tab goes away. The
 *    debounce timer's whole purpose is that it has not fired yet; leaving
 *    without it is exactly how autosave loses the last sentence.
 *
 * Writes are serialised: a change arriving mid-save waits for the in-flight
 * one and then goes, rather than racing it. Out-of-order PATCHes on the same
 * row would resurrect older text, which reads as the editor undoing you.
 */
export function useAutosave<T>(
  save: (payload: T) => Promise<void>,
  { delay = 1200, maxDelay = 8000 }: { delay?: number; maxDelay?: number } = {},
) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const pending = useRef<{ payload: T } | null>(null);
  const firstQueuedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const run = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) {
      await inFlight.current;
    }
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    firstQueuedAt.current = null;
    setState("saving");

    const p = (async () => {
      try {
        await saveRef.current(next.payload);
        setError(null);
        // Only claim "Saved" if nothing arrived while this write was away.
        setState(pending.current ? "dirty" : "saved");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save");
        setState("error");
        // The payload is not put back. It is stale by definition — the editor
        // holds the current document, and the next keystroke queues it again.
      }
    })();
    inFlight.current = p;
    await p;
    inFlight.current = null;
  }, []);

  const queue = useCallback(
    (payload: T) => {
      pending.current = { payload };
      setState("dirty");
      const now = Date.now();
      if (firstQueuedAt.current === null) firstQueuedAt.current = now;
      if (timer.current) clearTimeout(timer.current);
      const waited = now - firstQueuedAt.current;
      timer.current = setTimeout(() => void run(), Math.min(delay, Math.max(0, maxDelay - waited)));
    },
    [delay, maxDelay, run],
  );

  /** Write anything outstanding now. Safe to call when there is nothing. */
  const flush = useCallback(async () => {
    await run();
  }, [run]);

  const hasPending = useCallback(() => pending.current !== null, []);

  useEffect(() => {
    // A tab being hidden is the one warning a phone gives before it may never
    // come back; beforeunload never fires on iOS. Flush on both.
    const onHide = () => {
      if (document.visibilityState === "hidden") void run();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!pending.current && !inFlight.current) return;
      void run();
      e.preventDefault();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      // Unmount is a close: whatever is queued goes now.
      void run();
    };
  }, [run]);

  return { state, error, queue, flush, hasPending };
}

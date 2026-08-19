/**
 * Toasts, and the undo that makes destructive actions cheap.
 *
 * A module-level store rather than a React context. Every layer of this app
 * can fail — a drag, an autosave, a sync, a delete three components deep —
 * and threading a `notify` prop through all of them to reach a provider at
 * the root would be a lot of plumbing for a list of four strings. Components
 * import `toast` and call it; `<Toaster />` subscribes once.
 *
 * The undo model is deliberately optimistic-with-a-delay rather than
 * delete-then-restore: the row is removed from the screen immediately, the
 * database write is held for a few seconds, and Undo simply cancels a timer.
 * Restoring after a real delete would mean re-inserting rows under new ids
 * and re-parenting everything that pointed at them — which is not an undo,
 * it is a similar-looking copy.
 */

export type ToastKind = "info" | "error" | "success";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  /** Present only while an undoable action is still cancellable. */
  undo?: () => void;
  /** ms until it disappears on its own. */
  duration: number;
};

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit() {
  // A fresh array each time: React bails out of a re-render if the reference
  // it is given is the same one it already has.
  const snapshot = [...toasts];
  for (const l of listeners) l(snapshot);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l([...toasts]);
  return () => {
    listeners.delete(l);
  };
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(t: Omit<Toast, "id">): number {
  const id = nextId++;
  // Newest first, and capped. A failing autosave can fire repeatedly, and a
  // stack that grows without limit would cover the document it is complaining
  // about.
  toasts = [{ ...t, id }, ...toasts].slice(0, 4);
  emit();
  if (t.duration > 0) window.setTimeout(() => dismiss(id), t.duration);
  return id;
}

export function toast(message: string, kind: ToastKind = "info") {
  // Errors stay until dismissed. Everything else is a receipt for something
  // the user just did and can be missed without cost.
  return push({ message, kind, duration: kind === "error" ? 0 : 4000 });
}

/**
 * Do something destructive, visibly and reversibly.
 *
 * `apply` updates the screen now. `commit` runs after the grace period unless
 * Undo cancels it; `revert` puts the screen back if it does. If the commit
 * fails, revert runs too — the row is still there, so the honest thing is to
 * show it again rather than leave a hole that reappears on the next refresh.
 */
export function undoable(opts: {
  message: string;
  apply: () => void;
  commit: () => Promise<unknown>;
  revert: () => void;
  onError?: (e: unknown) => void;
  graceMs?: number;
}) {
  const grace = opts.graceMs ?? 5000;
  opts.apply();

  let cancelled = false;
  const timer = window.setTimeout(async () => {
    if (cancelled) return;
    dismiss(id);
    try {
      await opts.commit();
    } catch (e) {
      opts.revert();
      opts.onError?.(e);
      toast(
        e instanceof Error ? e.message : "Could not finish that — put it back",
        "error",
      );
    }
  }, grace);

  const id = push({
    message: opts.message,
    kind: "info",
    duration: 0, // owned by the timer above, not by a second one racing it
    undo: () => {
      cancelled = true;
      window.clearTimeout(timer);
      opts.revert();
      dismiss(id);
    },
  });

  return id;
}

import { useEffect, useState } from "react";
import { subscribe, dismiss, undoLast, type Toast } from "../lib/toast";

/**
 * Whether a keystroke belongs to whatever the user is typing in.
 *
 * Ctrl+Z inside a text box already means something, and BlockNote keeps its
 * own history for note bodies. Stealing the key there would trade a working
 * undo for a worse one, so the app-level undo only exists where the browser
 * has nothing to offer.
 */
function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The one place toasts are rendered. Mounted once, at the root.
 *
 * `aria-live="polite"` rather than assertive even for errors: these announce
 * the result of something the user just did, and interrupting a screen reader
 * mid-sentence to say "Saved" is worse than waiting for the pause.
 *
 * It also owns Ctrl+Z, because the undo it presses is the one it renders:
 * the keystroke is a shortcut for the button next to the newest toast, not a
 * second, parallel history that could disagree with it.
 */
export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribe(setToasts), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "z" && e.key !== "Z") return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (isTextEntry(e.target)) return;
      // Only swallow the key if there was something to undo. Otherwise the
      // page has no opinion and the browser should keep whatever it had.
      if (undoLast()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="grow">{t.message}</span>
          {t.undo && (
            <button className="toast-action" onClick={t.undo}>
              Undo
            </button>
          )}
          <button
            className="toast-close"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

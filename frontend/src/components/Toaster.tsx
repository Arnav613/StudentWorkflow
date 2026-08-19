import { useEffect, useState } from "react";
import { subscribe, dismiss, type Toast } from "../lib/toast";

/**
 * The one place toasts are rendered. Mounted once, at the root.
 *
 * `aria-live="polite"` rather than assertive even for errors: these announce
 * the result of something the user just did, and interrupting a screen reader
 * mid-sentence to say "Saved" is worse than waiting for the pause.
 */
export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribe(setToasts), []);

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

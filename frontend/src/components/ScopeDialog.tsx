import { useEffect, useRef } from "react";

/**
 * "…and every Tuesday?"
 *
 * The one question in this app that genuinely has to be asked. Everything else
 * destructive is done immediately and undone from a toast, because the answer
 * is almost always yes and a confirm box in front of it is a tax on being
 * right. This is different: the three answers are all reasonable, the app
 * cannot guess which one you mean, and getting it wrong silently changes every
 * Tuesday for the rest of term.
 *
 * It was a strip inside the card first. That was wrong for the room it had —
 * three choices, each a phrase rather than a word, wrapped across a card nine
 * rem wide and pushed the rest of the column down while it was open. A
 * question worth asking is worth the middle of the screen.
 *
 * Escape and the backdrop both mean cancel, and cancel is always a real answer
 * here — for a move it leaves the one-off standing, for a removal it leaves
 * everything alone.
 */
export type Scope = "once" | "weekday" | "routine";

export default function ScopeDialog({
  title,
  weekday,
  everyDay,
  onceLabel,
  routineLabel,
  danger,
  onChoose,
  onCancel,
}: {
  /** What just happened, or is about to. A sentence, not a heading. */
  title: string;
  /** "Tuesday". Names the middle scope in the user's own terms. */
  weekday: string;
  /**
   * Whether the widest scope is worth offering separately. A routine that only
   * ever runs on one weekday has the same answer for "every Tuesday" and "the
   * whole routine", and showing both invites a coin toss between identical
   * outcomes.
   */
  everyDay: boolean;
  onceLabel: string;
  routineLabel: string;
  /** Red, for the removal version. The choices are the same shape either way. */
  danger?: boolean;
  onChoose: (scope: Scope) => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="scrim"
      role="presentation"
      // Only a press that both starts and ends on the backdrop counts. A drag
      // that began inside the panel and released outside it is a slip of the
      // hand, not a dismissal.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <p className="dialog-title">{title}</p>
        <div className="dialog-choices">
          <button
            ref={first}
            className="btn-quiet"
            onClick={() => onChoose("once")}
          >
            {onceLabel}
          </button>
          <button className="btn-quiet" onClick={() => onChoose("weekday")}>
            Every {weekday}
          </button>
          {everyDay && (
            <button
              className={danger ? "danger" : "btn-quiet"}
              onClick={() => onChoose("routine")}
            >
              {routineLabel}
            </button>
          )}
        </div>
        <button className="link dialog-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

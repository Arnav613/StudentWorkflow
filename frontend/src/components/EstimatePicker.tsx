import { useEffect, useRef, useState } from "react";
import { formatMinutes } from "../lib/schedule";

/**
 * How long a task takes, as a list you pick from.
 *
 * A number field asked for a precision nobody has. "How many minutes is this
 * essay" has no honest answer to the minute, and the box invited one anyway —
 * so it got typed once, at 60, and never revisited. Half hours up to three
 * are the granularity an estimate actually carries, and the whole list is
 * seven rows you can hit without reading.
 *
 * Three hours is the ceiling because the planner splits anything over ninety
 * minutes across sittings regardless: past that point the estimate stops
 * describing a task and starts describing a project, which wants splitting
 * into real tasks rather than a bigger number.
 *
 * The value is minutes, or null for unestimated — never zero. See migration
 * 0005: null is answered with a visible guess, zero would occupy no time in
 * the week and then take an afternoon.
 */

/** 30m, 1h, 1h 30m, 2h, 2h 30m, 3h. */
const SLOTS: number[] = [30, 60, 90, 120, 150, 180];

export default function EstimatePicker({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening lands on the current choice. Seven rows never scroll, so unlike
  // the time list there is nothing to centre — only something to focus.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLButtonElement>("[aria-selected=true]")
      ?.focus({ preventScroll: true });
  }, [open]);

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const options = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [],
    );
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      (at + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  function choose(minutes: number | null) {
    onChange(minutes);
    setOpen(false);
    trigger.current?.focus();
  }

  /*
   * A value the list does not contain still gets a row of its own.
   *
   * Rows created before this control existed can hold anything up to the
   * column's 16-hour cap, and a picker that silently failed to show 4h as
   * selected would look like it had already lost the number — and would then
   * really lose it on the next press.
   */
  const slots = value && !SLOTS.includes(value) ? [...SLOTS, value].sort((a, b) => a - b) : SLOTS;

  return (
    <div className="picker" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className={`picker-trigger${value ? "" : " empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-icon" aria-hidden="true">
          ◔
        </span>
        <span className="grow ellipsis">
          {value ? formatMinutes(value) : "Not estimated"}
        </span>
        <span className="picker-caret" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="picker-pop picker-list"
          role="listbox"
          aria-label="Takes about"
          ref={list}
          onKeyDown={onListKeyDown}
        >
          {/* Clearing belongs in the list, like the time field: going back to
              unestimated is a choice among answers — "I would rather the
              planner guess" — not a removal. */}
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={`picker-option${value ? "" : " selected"}`}
            onClick={() => choose(null)}
          >
            <span className="grow">Not estimated</span>
            <span className="muted small">Planner guesses</span>
          </button>

          {slots.map((slot) => (
            <button
              key={slot}
              type="button"
              role="option"
              aria-selected={slot === value}
              className={`picker-option${slot === value ? " selected" : ""}`}
              onClick={() => choose(slot)}
            >
              <span className="grow">{formatMinutes(slot)}</span>
              {/* The planner splits above this, and knowing that before you
                  choose is what stops 3h reading as one unbroken evening. */}
              {slot > 90 && <span className="muted small">Split across sittings</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

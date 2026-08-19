import { useEffect, useRef, useState } from "react";

/**
 * A time field, as a list you pick from.
 *
 * `<input type="time">` has the same problem the date input had — segmented
 * `--:-- --` chrome the browser owns and this app cannot style, sitting next
 * to a date field that is now a proper control — plus one of its own: it asks
 * for a time to the minute when a deadline is almost always on the half hour
 * or at the end of the day.
 *
 * So: a list, every thirty minutes, with 11:59 pm on the end because that is
 * what a submission portal actually closes at and it is the one time nobody
 * should have to reach by typing.
 *
 * The value is `HH:MM` in 24-hour form, exactly what the input produced, so
 * dueAtFrom is untouched. What is *displayed* follows the browser's locale,
 * like every other time in the app.
 */

/** 00:00, 00:30, … 23:30, then 23:59. */
const SLOTS: string[] = [
  ...Array.from({ length: 48 }, (_, i) => {
    const h = `${Math.floor(i / 2)}`.padStart(2, "0");
    return `${h}:${i % 2 ? "30" : "00"}`;
  }),
  "23:59",
];

function label(value: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return "No time";
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function TimePicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
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

  /*
   * Opening lands on the current choice — and on 9 am when there is none.
   * A 49-row list opened at midnight would put every hour anyone teaches at
   * below the fold, and scrolled to the middle of the working day it is one
   * short flick away from any of them.
   */
  useEffect(() => {
    if (!open) return;
    const target =
      list.current?.querySelector<HTMLButtonElement>("[aria-selected=true]") ??
      list.current?.querySelector<HTMLButtonElement>('[data-slot="09:00"]');
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
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

  function choose(slot: string) {
    onChange(slot);
    setOpen(false);
    trigger.current?.focus();
  }

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
          ◷
        </span>
        <span className="grow ellipsis">{label(value)}</span>
        <span className="picker-caret" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="picker-pop picker-list"
          role="listbox"
          aria-label="Time"
          ref={list}
          onKeyDown={onListKeyDown}
        >
          {/* Clearing sits in the list rather than on the trigger, unlike the
              date. A cleared time still leaves a due date, so it is a choice
              among times — "that day, no particular hour" — not a removal. */}
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={`picker-option${value ? "" : " selected"}`}
            onClick={() => choose("")}
          >
            <span className="grow">No time</span>
          </button>

          {SLOTS.map((slot) => (
            <button
              key={slot}
              type="button"
              role="option"
              data-slot={slot}
              aria-selected={slot === value}
              className={`picker-option${slot === value ? " selected" : ""}`}
              onClick={() => choose(slot)}
            >
              <span className="grow">{label(slot)}</span>
              {/* The one row worth naming: it is the deadline every portal
                  actually uses, and "11:59 pm" alone reads as a rounding
                  error next to a list of clean half hours. */}
              {slot === "23:59" && (
                <span className="muted small">End of day</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

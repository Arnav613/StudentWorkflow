import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A date field, as a calendar you open.
 *
 * `<input type="date">` was here first and it is genuinely bad in this
 * context: it renders as three cramped `dd/mm/yyyy` segments plus a browser
 * icon, styled by the browser rather than by this app, so it sat in a dark
 * form looking like a control from a different program — and it asks someone
 * to type a numeric date when the answer they have in mind is "Thursday".
 *
 * This is a button showing the date the way the cards say it, and a month
 * grid under it. Hand-rolled rather than a dependency: a picker is a month of
 * arithmetic and a popover, and react-day-picker would be 40kB to render
 * forty-two buttons.
 *
 * The value is `YYYY-MM-DD`, exactly what the input produced, so everything
 * downstream — dueAtFrom, the time field, the database — is untouched.
 */

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Local, not UTC. `toISOString().slice(0, 10)` is yesterday east of London. */
function toValue(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function startOfDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * The label on the trigger. Named days for the three that have names, because
 * "Tomorrow" is the form the deadline was thought in; a real date past that,
 * because "in 9 days" is not something anyone can plan around.
 */
function label(value: string): string {
  const d = parseValue(value);
  if (!d) return "No due date";
  const delta = Math.round((d.getTime() - startOfDay().getTime()) / 86_400_000);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    // The year only when it is not this one. Every deadline in a term is in
    // the current year, and printing it on all of them is four characters of
    // noise on the one field people scan.
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** The 42 cells of a month grid, Monday first, padded from the months either side. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // getDay() is Sunday-0; this app's week starts on Monday.
  const lead = (first.getDay() + 6) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export default function DatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() =>
    startOfDay(parseValue(value) ?? new Date()),
  );
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Opening on a date already chosen should land on that date's month, not
  // wherever the last browse ended up.
  useEffect(() => {
    if (open) setMonth(startOfDay(parseValue(value) ?? new Date()));
    // The month follows the value only at the moment of opening; changing it
    // while open is the browsing this exists for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click-outside and Escape. Both are the same requirement: a popover that
  // can only be dismissed by choosing something is a modal, and this is not.
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

  const today = startOfDay();
  const selected = parseValue(value);
  const days = useMemo(() => monthGrid(month), [month]);

  function choose(d: Date) {
    onChange(toValue(d));
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div className="picker" ref={wrap}>
      <button
        // Every button in here is type="button". This lives inside the add-task
        // form, and a bare <button> submits it — picking a month would have
        // created the task.
        type="button"
        ref={trigger}
        className={`picker-trigger${value ? "" : " empty"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-icon" aria-hidden="true">
          ▤
        </span>
        <span className="grow">{label(value)}</span>
        {/* Clearing is on the trigger, not buried in the popover: taking a due
            date off is as ordinary as putting one on, and it should not cost
            opening a calendar. A span rather than a nested button, which is
            invalid HTML and which React would not let sit inside the trigger. */}
        {value && (
          <span
            className="datepicker-clear"
            role="button"
            tabIndex={0}
            aria-label="Clear due date"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onChange("");
            }}
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div className="picker-pop datepicker-pop" role="dialog" aria-label="Choose a date">
          <div className="datepicker-head">
            <button
              type="button"
              className="link icon-btn"
              aria-label="Previous month"
              onClick={() =>
                setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))
              }
            >
              ‹
            </button>
            <span className="datepicker-month">
              {month.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
            </span>
            <button
              type="button"
              className="link icon-btn"
              aria-label="Next month"
              onClick={() =>
                setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))
              }
            >
              ›
            </button>
          </div>

          <div className="datepicker-weekdays" aria-hidden="true">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>

          <div className="datepicker-grid">
            {days.map((d) => {
              const outside = d.getMonth() !== month.getMonth();
              const isToday = d.getTime() === today.getTime();
              const isSelected = selected?.getTime() === d.getTime();
              return (
                <button
                  key={d.getTime()}
                  type="button"
                  className={[
                    "datepicker-day",
                    outside ? "outside" : "",
                    isToday ? "today" : "",
                    isSelected ? "selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => choose(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {/* The dates most deadlines actually are, one press away. */}
          <div className="datepicker-foot">
            <button type="button" className="link" onClick={() => choose(today)}>
              Today
            </button>
            <button
              type="button"
              className="link"
              onClick={() => choose(addDays(today, 1))}
            >
              Tomorrow
            </button>
            <button
              type="button"
              className="link"
              onClick={() => choose(addDays(today, 7))}
            >
              Next week
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

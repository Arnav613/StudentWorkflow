import { useMemo, useState } from "react";
import * as db from "../lib/db";
import { toast, undoable } from "../lib/toast";
import { clockOfMinutes, formatMinutes, hhmmOf, minutesOfDay } from "../lib/schedule";
import TimePicker from "./TimePicker";
import type { DataStore } from "../hooks/useData";
import type { PlanBlock, StudyWindow } from "../lib/types";

/**
 * The hours you are actually willing to work in.
 *
 * Until now the planner assumed 8am to 10pm, every day, for everybody — a
 * fourteen-hour block nobody has ever had, which is why a plan could look full
 * and still be describing somebody else's Tuesday. A real day is a morning
 * that ends when the lectures do, an afternoon, and a late block, with gaps
 * between them that are lunch and a commute and not study time.
 *
 * Two rules, and they are the reason this is a list rather than a pair of
 * fields:
 *
 *   - a day has several windows, not one. "9 to 12 and 3 to 6 and 9 to 12"
 *     is the normal shape of a week, and a single start/end pair can only
 *     describe it by lying about the middle.
 *   - a window applying to every day is not overridden by a Tuesday one, it
 *     is added to it. Overriding needs a rule for what happens when two only
 *     partly overlap, and every such rule surprises somebody.
 *
 * Editable in place, from the page the plan is on. A schedule changes with
 * the term and with your mood, and a settings screen two clicks away is a
 * schedule that stays wrong all semester.
 */
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const EVERY_DAY = "";

/** The picker cannot say midnight; as the *end* of a block, 11:59pm means it. */
const END_OF_DAY = 24 * 60;

function toMinutes(hhmm: string, asEnd = false): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const m = minutesOfDay(hhmm);
  return asEnd && m === 23 * 60 + 59 ? END_OF_DAY : m;
}

export default function HoursPanel({
  store,
  events,
}: {
  store: DataStore;
  /** Lectures on the board, used to offer hours shaped around them. */
  events: PlanBlock[];
}) {
  const { studyWindows, refresh, setStudyWindows, userId } = store;
  const [weekday, setWeekday] = useState<string>(EVERY_DAY);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("12:00");
  const [busy, setBusy] = useState(false);

  /**
   * Hours that would hold this week's classes, for the days that have any.
   *
   * The other half of "study blocks form around your classes". The planner
   * already carves a lecture out of whatever window contains it — that part
   * needs no button and never did. What it cannot do is guess that a day with
   * a 9am and an 11am lecture is a day you are on campus from nine until noon,
   * and that is the window worth offering.
   *
   * Offered, never applied. A suggestion that wrote itself into your week
   * would be the app deciding when you study, which is the one thing this
   * panel exists to stop it doing. Days you have already described are left
   * alone.
   */
  const suggestions = useMemo(() => {
    const spans = new Map<number, { start: number; end: number }>();
    for (const e of events) {
      const start = new Date(e.starts_at);
      const end = new Date(e.ends_at);
      const day = start.getDay();
      const from = start.getHours() * 60 + start.getMinutes();
      const until = end.getHours() * 60 + end.getMinutes();
      const span = spans.get(day);
      if (span) {
        span.start = Math.min(span.start, from);
        span.end = Math.max(span.end, until);
      } else {
        spans.set(day, { start: from, end: until });
      }
    }

    const described = new Set(
      studyWindows.filter((w) => w.active && w.weekday !== null).map((w) => w.weekday),
    );
    const daily = studyWindows.some((w) => w.active && w.weekday === null);

    return [...spans]
      .filter(([day]) => !described.has(day) && !daily)
      .map(([day, span]) => ({
        weekday: day,
        // Rounded outward to the half hour. Nobody starts studying at 9:07,
        // and a window that begins exactly when the lecture does leaves no
        // room to have walked there.
        starts_minute: Math.max(0, Math.floor(span.start / 30) * 30),
        ends_minute: Math.min(END_OF_DAY, Math.ceil(span.end / 30) * 30),
      }))
      .sort((a, b) => a.weekday - b.weekday);
  }, [events, studyWindows]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const starts = toMinutes(from);
    const ends = toMinutes(to, true);
    if (starts === null || ends === null) return;
    if (ends <= starts) {
      toast("A block has to end after it starts", "info");
      return;
    }
    setBusy(true);
    try {
      await db.createStudyWindow({
        user_id: userId,
        weekday: weekday === EVERY_DAY ? null : Number(weekday),
        starts_minute: starts,
        ends_minute: ends,
      });
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add those hours", "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Edited in place, and saved as you pick.
   *
   * Optimistic for the same reason the board's drag is: this is a control you
   * reach for because the plan in front of you is wrong, and a half-second of
   * the old number sitting there while a round trip lands reads as the app
   * refusing the change.
   */
  async function edit(w: StudyWindow, patch: Partial<StudyWindow>) {
    const next = { ...w, ...patch };
    if (next.ends_minute <= next.starts_minute) {
      toast("A block has to end after it starts", "info");
      return;
    }
    setStudyWindows((prev) => prev.map((x) => (x.id === w.id ? next : x)));
    try {
      await db.updateStudyWindow(w.id, patch);
    } catch {
      setStudyWindows((prev) => prev.map((x) => (x.id === w.id ? w : x)));
      toast("Could not change those hours", "error");
    }
  }

  function remove(w: StudyWindow) {
    const previous = studyWindows;
    undoable({
      message: `Removed ${label(w)}`,
      apply: () => setStudyWindows((prev) => prev.filter((x) => x.id !== w.id)),
      commit: () => db.deleteStudyWindow(w.id),
      revert: () => setStudyWindows(previous),
      onError: () => toast("Those hours are still there", "info"),
    });
  }

  async function accept(s: {
    weekday: number;
    starts_minute: number;
    ends_minute: number;
  }) {
    try {
      await db.createStudyWindow({ user_id: userId, ...s });
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add those hours", "error");
    }
  }

  async function acceptAll() {
    if (!suggestions.length) return;
    setBusy(true);
    try {
      await db.createStudyWindows(
        suggestions.map((s) => ({ user_id: userId, ...s })),
      );
      await refresh();
      toast("Hours added around your classes", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add those hours", "error");
    } finally {
      setBusy(false);
    }
  }

  const sorted = [...studyWindows].sort(
    (a, b) =>
      (a.weekday ?? -1) - (b.weekday ?? -1) || a.starts_minute - b.starts_minute,
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Study hours</h2>
        <span className="muted small">
          {studyWindows.length
            ? "The only hours the planner will fill. Classes are carved out of them automatically."
            : "Nothing set, so the planner assumes 8 am to 10 pm every day."}
        </span>
      </div>

      {/* Suggested, never applied. A week that rearranged itself the first
          time it saw your timetable would be the app deciding when you study,
          which is the one thing this panel exists to prevent. */}
      {suggestions.length > 0 && (
        <div className="hours-suggest">
          <p className="muted small">
            Your calendar has classes on{" "}
            {suggestions.map((s) => DAY_NAMES[s.weekday]).join(", ")}. Hours that
            would hold them:
          </p>
          <div className="row hours-suggest-row">
            {suggestions.map((s) => (
              <button
                key={s.weekday}
                className="tag tag-button"
                onClick={() => void accept(s)}
                disabled={busy}
              >
                {DAY_NAMES[s.weekday].slice(0, 3)}{" "}
                {clockOfMinutes(s.starts_minute)}–{clockOfMinutes(s.ends_minute)}
              </button>
            ))}
            {suggestions.length > 1 && (
              <button className="link" onClick={() => void acceptAll()} disabled={busy}>
                Add all
              </button>
            )}
          </div>
        </div>
      )}

      <form className="routine-form" onSubmit={add}>
        <select
          value={weekday}
          onChange={(e) => setWeekday(e.target.value)}
          aria-label="Day"
        >
          <option value={EVERY_DAY}>Every day</option>
          {DAY_NAMES.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
        <TimePicker value={from} onChange={setFrom} />
        <span className="muted small">to</span>
        <TimePicker value={to} onChange={setTo} />
        <button disabled={busy}>Add hours</button>
      </form>

      {sorted.length === 0 ? (
        <p className="muted small">
          Add the blocks you actually work in — a morning, an afternoon, a late
          stretch — and nothing will ever be planned outside them.
        </p>
      ) : (
        <ul className="list hours-list">
          {sorted.map((w) => (
            <li key={w.id} className={w.active ? "" : "paused"}>
              <span className="hours-day">
                {w.weekday === null ? "Every day" : DAY_NAMES[w.weekday]}
              </span>
              <TimePicker
                value={hhmmOf(w.starts_minute)}
                compact
                display={clockOfMinutes(w.starts_minute)}
                onChange={(v) => {
                  const m = toMinutes(v);
                  if (m !== null) void edit(w, { starts_minute: m });
                }}
              />
              <span className="muted small">to</span>
              <TimePicker
                value={hhmmOf(w.ends_minute)}
                compact
                display={clockOfMinutes(w.ends_minute)}
                onChange={(v) => {
                  const m = toMinutes(v, true);
                  if (m !== null) void edit(w, { ends_minute: m });
                }}
              />
              <span className="muted small grow">
                {formatMinutes(w.ends_minute - w.starts_minute)}
              </span>
              <button className="link" onClick={() => void edit(w, { active: !w.active })}>
                {w.active ? "Pause" : "Resume"}
              </button>
              <button className="link danger" onClick={() => remove(w)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function label(w: StudyWindow): string {
  const day = w.weekday === null ? "every day" : DAY_NAMES[w.weekday];
  return `${clockOfMinutes(w.starts_minute)}–${clockOfMinutes(w.ends_minute)} ${day}`;
}

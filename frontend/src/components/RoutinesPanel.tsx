import { useState } from "react";
import * as db from "../lib/db";
import { toast, undoable } from "../lib/toast";
import { clockOf, formatMinutes } from "../lib/schedule";
import TimePicker from "./TimePicker";
import type { DataStore } from "../hooks/useData";
import type { Routine } from "../lib/types";

/**
 * The things that eat your week but are not work.
 *
 * Lives under the grid rather than in a settings screen: a routine is only
 * ever added because you just looked at a plan that ignored your Tuesday
 * rehearsal, and making you leave the page to say so is how it never gets
 * said.
 */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Daily is the default. Most routines that are worth entering are daily. */
const EVERY_DAY = "";

/**
 * The routines almost everybody has, one press each.
 *
 * An empty panel with three fields asks you to invent both the answer and the
 * format of the answer, which is why the honest response to it is to close the
 * tab and let the planner keep believing your evenings are free. These are not
 * defaults imposed on anyone — nothing exists until it is pressed — they are
 * the first draft, and every part of it is editable afterwards.
 *
 * The times are the ones these things actually happen at rather than round
 * numbers: gym after the working day, dinner at seven, a commute against the
 * morning.
 */
const PRESETS: { title: string; time_of_day: string; duration_minutes: number }[] = [
  { title: "Gym", time_of_day: "17:00", duration_minutes: 60 },
  { title: "Dinner", time_of_day: "19:00", duration_minutes: 60 },
  { title: "Commute", time_of_day: "08:30", duration_minutes: 30 },
  { title: "Wind down", time_of_day: "23:00", duration_minutes: 60 },
];

/** "17:00" → [17, 0], for the one place a preset has to become a clock. */
function timeParts(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(":").map(Number);
  return [h, m];
}

export default function RoutinesPanel({ store }: { store: DataStore }) {
  const { routines, refresh, setRoutines, userId } = store;
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("07:00");
  const [weekday, setWeekday] = useState<string>(EVERY_DAY);
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const length = Number(minutes);
    if (!title.trim() || !time || !Number.isFinite(length) || length <= 0) return;
    setBusy(true);
    try {
      await db.createRoutine({
        user_id: userId,
        title: title.trim(),
        weekday: weekday === EVERY_DAY ? null : Number(weekday),
        time_of_day: time,
        duration_minutes: Math.round(length),
      });
      setTitle("");
      await refresh();
      toast("Routine added", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add that", "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pausing, not deleting. A routine that lapses for a term comes back, and
   * an inactive one still renders here — greyed — because a paused routine
   * that disappeared would be indistinguishable from one that was deleted.
   */
  async function toggle(r: Routine) {
    setRoutines((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, active: !x.active } : x)),
    );
    try {
      await db.updateRoutine(r.id, { active: !r.active });
    } catch {
      setRoutines((prev) => prev.map((x) => (x.id === r.id ? r : x)));
      toast("Could not change that routine", "error");
    }
  }

  function remove(r: Routine) {
    const previous = routines;
    undoable({
      message: `Deleted "${r.title}"`,
      apply: () => setRoutines((prev) => prev.filter((x) => x.id !== r.id)),
      commit: () => db.deleteRoutine(r.id),
      revert: () => setRoutines(previous),
      onError: () => toast("The routine is still there", "info"),
    });
  }

  /** A preset, added as it stands. Everything about it is editable after. */
  async function quickAdd(p: (typeof PRESETS)[number]) {
    setBusy(true);
    try {
      await db.createRoutine({
        user_id: userId,
        title: p.title,
        weekday: null,
        time_of_day: p.time_of_day,
        duration_minutes: p.duration_minutes,
      });
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add that", "error");
    } finally {
      setBusy(false);
    }
  }

  // Only the ones you have not got. A press that appears to do nothing because
  // the routine already exists is worse than no button.
  const offered = PRESETS.filter(
    (p) => !routines.some((r) => r.title.toLowerCase() === p.title.toLowerCase()),
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Routines</h2>
        <span className="muted small">
          Time that is already spoken for. Never lands on the board.
        </span>
      </div>

      {offered.length > 0 && (
        <div className="row routine-presets">
          {offered.map((p) => (
            <button
              key={p.title}
              type="button"
              className="tag tag-button"
              disabled={busy}
              onClick={() => void quickAdd(p)}
              title={`Every day, ${formatMinutes(p.duration_minutes)}`}
            >
              + {p.title} {clockOf(new Date(2000, 0, 1, ...timeParts(p.time_of_day)))}
            </button>
          ))}
        </div>
      )}

      <form className="routine-form" onSubmit={add}>
        <input
          placeholder="Gym, laundry, rehearsal…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
          <option value={EVERY_DAY}>Every day</option>
          {DAY_NAMES.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
        <TimePicker value={time} onChange={setTime} />
        <label className="routine-length">
          <input
            type="number"
            min={5}
            max={960}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-label="Minutes"
          />
          <span className="muted small">min</span>
        </label>
        <button disabled={busy || !title.trim()}>Add</button>
      </form>

      {routines.length === 0 ? (
        <p className="muted small">
          Nothing yet. Add the hours you already know are gone and the plan will
          work around them.
        </p>
      ) : (
        <ul className="list routine-list">
          {routines.map((r) => (
            <li key={r.id} className={r.active ? "" : "paused"}>
              <span className="grow">{r.title}</span>
              <span className="muted small">
                {r.weekday === null ? "Every day" : DAY_NAMES[r.weekday]} ·{" "}
                {r.time_of_day.slice(0, 5)} · {formatMinutes(r.duration_minutes)}
              </span>
              <button className="link" onClick={() => void toggle(r)}>
                {r.active ? "Pause" : "Resume"}
              </button>
              <button className="link danger" onClick={() => remove(r)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

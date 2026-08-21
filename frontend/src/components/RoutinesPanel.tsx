import { useState } from "react";
import * as db from "../lib/db";
import { toast, errorText } from "../lib/toast";
import { PLAN_DAYS } from "../lib/schedule";
import TimePicker from "./TimePicker";
import type { DataStore } from "../hooks/useData";

/**
 * A way of putting the same block on several days at once.
 *
 * Deliberately not a manager. There used to be a list here of every routine
 * you had, sitting under a grid that was already showing each of them on the
 * days they happen — the same fact in two places, one of which you could edit
 * and one of which you could not, and neither of which was obviously in
 * charge. The grid won: it is where the week is, it is where a routine is
 * wrong, and it is now where a routine is changed and removed.
 *
 * So all that is left is the sentence you could not say on the grid, which is
 * "and again tomorrow". Type it, and the blocks appear — no Replan, no second
 * step. A routine that needed a button pressed before anything happened was a
 * setting pretending to be an action.
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

/** Daily is the default. Most things worth repeating are daily. */
const EVERY_DAY = "";

export default function RoutinesPanel({ store }: { store: DataStore }) {
  const { refresh, userId } = store;
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("17:00");
  const [weekday, setWeekday] = useState<string>(EVERY_DAY);
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const length = Number(minutes);
    if (!title.trim() || !time || !Number.isFinite(length) || length <= 0) return;
    setBusy(true);
    try {
      const routine = await db.createRoutine({
        user_id: userId,
        title: title.trim(),
        weekday: weekday === EVERY_DAY ? null : Number(weekday),
        time_of_day: time,
        duration_minutes: Math.round(length),
      });
      // Straight onto the grid. The whole complaint about routines was that
      // creating one changed a list and not the week.
      //
      // From now rather than from midnight: a 7am routine entered at three in
      // the afternoon should not put a block on this morning, which is an hour
      // nobody can still keep.
      await db.resyncRoutine(userId, routine, [], [], new Date(), PLAN_DAYS);
      setTitle("");
      await refresh();
      toast(`${routine.title} added to your week`, "success");
    } catch (err) {
      toast(errorText(err, "Could not add that"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Repeating blocks</h2>
      </div>

      <form className="routine-form" onSubmit={add}>
        <input
          placeholder="Gym, laundry, rehearsal…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
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
    </section>
  );
}

/**
 * The fortnight ahead: how much work each day owes, and how many hours it has.
 *
 * The board says what is due and the week says when you will do it. Neither
 * can answer the question that actually ruins a term, which is whether the
 * fourteenth is survivable — because by the time a bad day is inside the
 * seven-day plan, the only remaining move is to do less of it.
 *
 * Pure, like `lib/board.ts` and `lib/schedule.ts`, and deliberately not a
 * second scheduler: it places nothing. Capacity comes from the planner's own
 * `commitments` and `freeWindows`, so the line on this chart is the same
 * arithmetic that decides what fits next week. Two implementations of "how
 * many hours does Thursday have" would put two believable numbers on two
 * screens with no way to tell which one was lying.
 */

import {
  commitments,
  dayKey,
  estimateFor,
  freeWindows,
  planDays,
  unscheduled,
  type BusyInterval,
  type PlannableTask,
} from "./schedule";
import type { PlanBlock, Routine, RoutineOverride } from "./types";

/**
 * A fortnight, which is the horizon the plan says this feature is for.
 *
 * Long enough that a bad Thursday arrives while there is still time to move
 * work off it; short enough that the estimates it is built from are things
 * you have actually looked at. A month of this chart would be a month of
 * class medians drawn as if they were facts.
 */
export const FORECAST_DAYS = 14;

/** One class's share of one day's demand. A null class is unfiled work. */
export type Slice = { class_id: string | null; minutes: number };

export type ForecastDay = {
  /** Local midnight. The column, not an instant. */
  day: Date;
  /** Estimated minutes falling due on this day, largest class first. */
  demand: Slice[];
  demandMinutes: number;
  /** Free minutes the planner would find here — waking hours minus the rest. */
  capacity: number;
  /** More owed than there are hours to owe it in. */
  over: boolean;
  /**
   * True on the first column only, when work already past its due date has
   * been folded into it. An overdue essay is not a bar in the past — it is
   * this morning's problem, and drawing it anywhere else would let the
   * fortnight open on an empty Monday.
   */
  carriesOverdue: boolean;
};

export type ClassLoad = {
  class_id: string | null;
  /** Estimated minutes still owed, across every unfinished task. */
  minutes: number;
  tasks: number;
  /** Of those minutes, how many are on no block in the week plan. */
  unplannedMinutes: number;
  /** Any of this rests on a class median rather than a number you typed. */
  guessed: boolean;
};

export type Forecast = {
  days: ForecastDay[];
  byClass: ClassLoad[];
  /** Unfinished tasks whose hours are not all on the grid. Phase 07's number. */
  unplanned: number;
  unplannedMinutes: number;
  /** Everything unfinished, dated or not. */
  totalMinutes: number;
  /**
   * Work with no due date, in minutes and in count.
   *
   * It is real and it is in `byClass`, but it belongs to no column, so the
   * chart cannot draw it. Saying so is the difference between a quiet
   * fortnight and a quiet fortnight with six hours hiding behind it.
   */
  undatedMinutes: number;
  undated: number;
  /** The tallest thing on the chart — demand or capacity — for scaling. */
  peak: number;
};

export type ForecastInput = {
  tasks: PlannableTask[];
  routines: Routine[];
  routineOverrides?: RoutineOverride[];
  /** Hours Google says are gone. Times only; the forecast reads no titles. */
  busy: BusyInterval[];
  /**
   * Commitments a person pinned by hand — routine blocks they moved.
   *
   * Task blocks are deliberately *not* passed here. An hour locked for an
   * essay is work, and work is already on the demand side of this chart;
   * counting it as occupied as well would take the same hour off capacity and
   * report a day as overloaded because you had planned it.
   */
  locked: PlanBlock[];
  /** The plan as saved, for the unplanned figures. */
  blocks: { task_id: string | null; starts_at: string; ends_at: string }[];
  /** Now. The first column starts at its midnight; capacity starts at it. */
  from: Date;
  days?: number;
  medians?: Map<string, number>;
};

export function forecast({
  tasks,
  routines,
  routineOverrides = [],
  busy,
  locked,
  blocks,
  from,
  days = FORECAST_DAYS,
  medians,
}: ForecastInput): Forecast {
  const horizon = planDays(from, days);
  const index = new Map(horizon.map((d, i) => [dayKey(d), i]));
  const live = tasks.filter((t) => t.status !== "done");

  /* --- Capacity: the planner's own answer, not a second one --------------- */

  const { occupied } = commitments({
    routines,
    routineOverrides,
    busy,
    locked,
    from,
    days,
  });

  const capacity = horizon.map(() => 0);
  for (const w of freeWindows(occupied, from, days)) {
    const i = index.get(dayKey(new Date(w.start)));
    if (i !== undefined) capacity[i] += (w.end - w.start) / 60_000;
  }

  /* --- Demand: hours due, by day, by class -------------------------------- */

  const demand: Map<string | null, number>[] = horizon.map(() => new Map());
  let carriesOverdue = false;
  let totalMinutes = 0;
  let undatedMinutes = 0;
  let undated = 0;

  const load = new Map<string | null, ClassLoad>();
  function bump(id: string | null): ClassLoad {
    const existing = load.get(id);
    if (existing) return existing;
    const fresh: ClassLoad = {
      class_id: id,
      minutes: 0,
      tasks: 0,
      unplannedMinutes: 0,
      guessed: false,
    };
    load.set(id, fresh);
    return fresh;
  }

  for (const t of live) {
    const { minutes, guessed } = estimateFor(t, medians);
    totalMinutes += minutes;

    const row = bump(t.class_id);
    row.minutes += minutes;
    row.tasks += 1;
    row.guessed ||= guessed;

    if (!t.due_at) {
      undatedMinutes += minutes;
      undated += 1;
      continue;
    }

    const due = new Date(t.due_at);
    let i = index.get(dayKey(due));
    if (i === undefined) {
      // Past the far edge of the fortnight: real, counted in the class totals
      // below, and simply not a column yet.
      if (due.getTime() >= horizon[0].getTime()) continue;
      // Overdue work lands on today — not in the past, and not nowhere. It is
      // still owed, and today is the soonest anyone can pay it.
      i = 0;
      carriesOverdue = true;
    }
    demand[i].set(t.class_id, (demand[i].get(t.class_id) ?? 0) + minutes);
  }

  /* --- What the saved plan does not account for --------------------------- */

  const byId = new Map(live.map((t) => [t.id, t]));
  const loose = unscheduled(live, blocks, medians, from.getTime());
  let unplannedMinutes = 0;
  for (const u of loose) {
    unplannedMinutes += u.minutes;
    const task = byId.get(u.task_id);
    if (task) bump(task.class_id).unplannedMinutes += u.minutes;
  }

  const out: ForecastDay[] = horizon.map((day, i) => {
    const slices = [...demand[i]]
      .map(([class_id, minutes]) => ({ class_id, minutes }))
      .sort((a, b) => b.minutes - a.minutes);
    const demandMinutes = slices.reduce((sum, s) => sum + s.minutes, 0);
    return {
      day,
      demand: slices,
      demandMinutes,
      capacity: capacity[i],
      // Strictly more, so a day that exactly fills itself is not an alarm. It
      // is also not comfortable, and a bar standing level with the line says
      // that on its own without needing a colour for it.
      over: demandMinutes > capacity[i],
      carriesOverdue: i === 0 && carriesOverdue,
    };
  });

  return {
    days: out,
    byClass: [...load.values()].sort((a, b) => b.minutes - a.minutes),
    unplanned: loose.length,
    unplannedMinutes: Math.round(unplannedMinutes),
    totalMinutes: Math.round(totalMinutes),
    undatedMinutes: Math.round(undatedMinutes),
    undated,
    peak: Math.max(1, ...out.map((d) => Math.max(d.demandMinutes, d.capacity))),
  };
}

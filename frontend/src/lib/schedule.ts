/**
 * The week plan: which hours you will actually spend on what.
 *
 * One pure function, no I/O, no clock of its own — `from` is passed in, so
 * the same inputs always produce the same week and the whole thing can be
 * reasoned about (and one day tested) without a mounted React tree. This is
 * the `lib/board.ts` pattern for the one piece of logic in the app that is
 * genuinely an algorithm rather than a sort.
 *
 * It is greedy and it is earliest-deadline-first, which is the scheduling rule
 * a person already uses in their head. It is not an optimiser, and that is the
 * point: a planner nobody can predict is a planner nobody trusts, and the
 * failure mode of a clever one — quietly compressing eleven hours of work into
 * a Sunday to make the week look achievable — is worse than no plan at all.
 * Hence `unplaced`: what does not fit comes back and gets shown.
 */

import type { PlanBlock, Routine, Task } from "./types";

/** Waking hours the planner is allowed to fill. Outside these it plans nothing. */
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 22;

/**
 * The longest single sitting, and the break that follows one.
 *
 * Ninety minutes is where a session stops being work and starts being time at
 * a desk. Splitting without a gap would be theatre — two blocks touching end
 * to end are one long block with a line drawn through it — so the break is
 * real time the planner gives away.
 */
export const MAX_SESSION_MINUTES = 90;
export const BREAK_MINUTES = 15;

/**
 * Below this, a gap is not worth planning into. Twenty minutes between a
 * lecture and a rehearsal is a walk across campus, not a study session.
 *
 * The exception is a task with less than this left to do: fifteen minutes of
 * reading does fit in a fifteen-minute gap, and refusing to place it would
 * report it as unplaced while free time sat next to it.
 */
export const MIN_SESSION_MINUTES = 20;

/** What an unestimated task is assumed to take when its class has no history. */
export const DEFAULT_ESTIMATE_MINUTES = 60;

const MINUTE = 60_000;

export type BusyInterval = { starts_at: string; ends_at: string };

/** Everything the planner reads off a task. Nothing else on the row matters. */
export type PlannableTask = Pick<
  Task,
  "id" | "class_id" | "due_at" | "status" | "estimate_minutes"
>;

/** A block the planner decided on. Shaped for insert; no id until it is saved. */
export type PlannedBlock = {
  task_id: string | null;
  routine_id: string | null;
  starts_at: string;
  ends_at: string;
  locked: boolean;
};

export type Unplaced = {
  task_id: string;
  /** Minutes still unaccounted for after every window was tried. */
  minutes: number;
  /**
   * Why it did not fit. "deadline" means the week has room but not before the
   * due date — the honest, alarming one. "week" means there is no room left
   * at all in the days being planned.
   */
  reason: "deadline" | "week";
};

export type PlanInput = {
  tasks: PlannableTask[];
  routines: Routine[];
  /** Read-only from Google Calendar. Times only; no titles ever leave Google. */
  busy: BusyInterval[];
  /** Blocks a person placed by hand. Immovable, and planned around. */
  locked: PlanBlock[];
  /** The instant the plan starts. Nothing is ever scheduled before it. */
  from: Date;
  days?: number;
  /** Estimate fallback per class, from `classMedians`. */
  medians?: Map<string, number>;
};

export type Plan = {
  blocks: PlannedBlock[];
  unplaced: Unplaced[];
};

type Interval = { start: number; end: number };

/* ---------------------------------------------------------------------------
   Estimates
   ------------------------------------------------------------------------ */

/**
 * The median estimate a person has given for each class, over whatever tasks
 * it is handed. The board's live rows are the caller today, which is enough:
 * a class you have estimated nothing in gets no median, and falls back to the
 * flat default rather than to a number invented from a different course.
 *
 * Median rather than mean: one 8-hour term paper should not turn every
 * unestimated reading in the course into a four-hour job.
 */
export function classMedians(tasks: PlannableTask[]): Map<string, number> {
  const byClass = new Map<string, number[]>();
  for (const t of tasks) {
    if (!t.class_id || !t.estimate_minutes) continue;
    const list = byClass.get(t.class_id);
    if (list) list.push(t.estimate_minutes);
    else byClass.set(t.class_id, [t.estimate_minutes]);
  }

  const out = new Map<string, number>();
  for (const [classId, values] of byClass) {
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    out.set(
      classId,
      values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2),
    );
  }
  return out;
}

/**
 * How long to assume this takes, and whether that is a stated fact or a guess.
 *
 * The `guessed` flag is carried all the way to the card, where it renders in
 * italics. A number the app invented must never be indistinguishable from a
 * number the user typed — that is how a planner starts quietly lying.
 */
export function estimateFor(
  task: PlannableTask,
  medians?: Map<string, number>,
): { minutes: number; guessed: boolean } {
  if (task.estimate_minutes) return { minutes: task.estimate_minutes, guessed: false };
  const median = task.class_id ? medians?.get(task.class_id) : undefined;
  return { minutes: median ?? DEFAULT_ESTIMATE_MINUTES, guessed: true };
}

/* ---------------------------------------------------------------------------
   Time helpers
   ------------------------------------------------------------------------ */

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** The seven (or however many) days the plan covers, each at local midnight. */
export function planDays(from: Date, days: number): Date[] {
  const first = startOfDay(from);
  return Array.from({ length: days }, (_, i) => addDays(first, i));
}

/**
 * "HH:MM" or "HH:MM:SS" to minutes past midnight.
 *
 * Postgres `time` comes back as a string and is local wall-clock by
 * definition — parsing it as an instant is the bug that moves a 7am gym slot
 * when the clocks change.
 */
export function minutesOfDay(time: string): number {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
}

function at(day: Date, minutes: number): number {
  return day.getTime() + minutes * MINUTE;
}

/**
 * Subtract a set of intervals from one window.
 *
 * The occupied list is sorted and may overlap — a lecture on the calendar and
 * a routine covering the same hour is normal, not an error — so overlaps are
 * merged as they are consumed rather than assumed away.
 */
function carve(window: Interval, occupied: Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = window.start;

  for (const o of occupied) {
    if (o.end <= cursor) continue;
    if (o.start >= window.end) break;
    if (o.start > cursor) out.push({ start: cursor, end: Math.min(o.start, window.end) });
    cursor = Math.max(cursor, o.end);
    if (cursor >= window.end) return out;
  }

  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out;
}

/* ---------------------------------------------------------------------------
   The planner
   ------------------------------------------------------------------------ */

/**
 * Plan `days` days from `from`.
 *
 * Order of business, and the reason for it:
 *
 * 1. Routines and locked blocks become blocks immediately. They are not
 *    decisions this function gets to make — they are the shape of the week it
 *    has to work inside.
 * 2. Those, plus the calendar's busy intervals, are carved out of waking
 *    hours to leave the free windows.
 * 3. Tasks are placed earliest deadline first, each one taking the earliest
 *    free time it can reach, split at 90 minutes with a break between
 *    sittings, and never after its own due date.
 * 4. Whatever is left over is returned, loudly.
 */
export function planWeek({
  tasks,
  routines,
  busy,
  locked,
  from,
  days = 7,
  medians,
}: PlanInput): Plan {
  const horizon = planDays(from, days);
  const floor = from.getTime();
  const ceiling = at(addDays(horizon[0], days - 1), DAY_END_HOUR * 60);

  const blocks: PlannedBlock[] = [];
  const occupied: Interval[] = [];

  // 1a. Routines. A weekday of null is daily; anything already past is not a
  // commitment you can still keep, so it neither renders nor blocks time.
  for (const day of horizon) {
    for (const r of routines) {
      if (!r.active) continue;
      if (r.weekday !== null && r.weekday !== day.getDay()) continue;
      const start = at(day, minutesOfDay(r.time_of_day));
      const end = start + r.duration_minutes * MINUTE;
      if (end <= floor) continue;
      blocks.push({
        task_id: null,
        routine_id: r.id,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        locked: false,
      });
      occupied.push({ start, end });
    }
  }

  // 1b. Locked blocks, exactly as they are. These carry ids already; they are
  // re-emitted so the caller can render one list, and are recognisable by
  // locked === true when it comes to deciding what to write.
  const lockedMinutes = new Map<string, number>();
  for (const b of locked) {
    const start = Date.parse(b.starts_at);
    const end = Date.parse(b.ends_at);
    if (end <= floor || start >= ceiling) continue;
    blocks.push({
      task_id: b.task_id,
      routine_id: b.routine_id,
      starts_at: b.starts_at,
      ends_at: b.ends_at,
      locked: true,
    });
    occupied.push({ start, end });
    // Time you have already committed to a task is time it no longer needs.
    // Without this, locking a two-hour session for an essay would plan the
    // whole essay again around it.
    if (b.task_id) {
      const done = (end - start) / MINUTE;
      lockedMinutes.set(b.task_id, (lockedMinutes.get(b.task_id) ?? 0) + done);
    }
  }

  // 2. Busy intervals from Google. Times only — see routers/calendar.py.
  for (const b of busy) {
    const start = Date.parse(b.starts_at);
    const end = Date.parse(b.ends_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= floor || start >= ceiling) continue;
    occupied.push({ start, end });
  }

  occupied.sort((a, b) => a.start - b.start);

  const windows: Interval[] = [];
  for (const day of horizon) {
    const open = Math.max(at(day, DAY_START_HOUR * 60), floor);
    const close = at(day, DAY_END_HOUR * 60);
    if (close <= open) continue;
    windows.push(...carve({ start: open, end: close }, occupied));
  }

  // 3. Tasks, earliest deadline first. Undated work sorts last — "sometime"
  // must never displace "Thursday" — and among equals the shorter job goes
  // first, so a week ends with more things finished rather than more started.
  const queue = tasks
    .filter((t) => t.status !== "done")
    .map((t) => {
      const { minutes, guessed } = estimateFor(t, medians);
      const due = t.due_at ? Date.parse(t.due_at) : Number.POSITIVE_INFINITY;
      return {
        task: t,
        guessed,
        remaining: Math.max(0, minutes - (lockedMinutes.get(t.id) ?? 0)),
        // Sorts by the real deadline, so overdue work still comes first.
        due,
        /*
         * But it is *placed* against this one. A deadline already in the past
         * cannot be honoured, and enforcing it anyway would refuse to plan
         * the overdue essay at all — reporting the one thing that most needs
         * an hour on Tuesday as unplaceable, forever.
         */
        limit: due <= floor ? Number.POSITIVE_INFINITY : due,
      };
    })
    .filter((t) => t.remaining > 0)
    .sort(
      (a, b) =>
        a.due - b.due || a.remaining - b.remaining || (a.task.id < b.task.id ? -1 : 1),
    );

  const unplaced: Unplaced[] = [];

  for (const item of queue) {
    let remaining = item.remaining;
    let reachedDeadline = false;

    for (const w of windows) {
      if (remaining <= 0) break;
      if (w.end - w.start <= 0) continue;

      // Nothing is scheduled after its own due date. A plan that puts the
      // work after the deadline is not a plan, it is a record of a failure
      // that has not happened yet.
      const limit = Math.min(w.end, item.limit);
      if (limit <= w.start) {
        if (item.limit <= w.start) reachedDeadline = true;
        continue;
      }

      const available = (limit - w.start) / MINUTE;
      const want = Math.min(remaining, MAX_SESSION_MINUTES);
      // A short gap is only worth using if it finishes the job.
      if (available < Math.min(MIN_SESSION_MINUTES, remaining)) continue;

      const length = Math.min(want, available);
      const start = w.start;
      const end = start + length * MINUTE;

      blocks.push({
        task_id: item.task.id,
        routine_id: null,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        locked: false,
      });

      remaining -= length;
      // The break is only owed if this sitting hit the cap and there is more
      // to come; finishing a task does not earn a fifteen-minute hole.
      const gap = remaining > 0 && length >= MAX_SESSION_MINUTES ? BREAK_MINUTES : 0;
      w.start = Math.min(end + gap * MINUTE, w.end);
    }

    if (remaining > 0) {
      unplaced.push({
        task_id: item.task.id,
        minutes: Math.round(remaining),
        // If free time existed but all of it fell after the due date, the
        // problem is the deadline, not the week. The two need different
        // sentences on screen and they are not interchangeable.
        reason:
          reachedDeadline && item.limit !== Number.POSITIVE_INFINITY
            ? "deadline"
            : "week",
      });
    }
  }

  blocks.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  return { blocks, unplaced };
}

/**
 * What the *saved* plan does not account for.
 *
 * Deliberately derived from the blocks actually in the database rather than
 * from `planWeek`'s `unplaced`, even though the two usually agree. `unplaced`
 * is a fact about one press of Regenerate; this is a fact about the plan on
 * screen right now, and it stays true after a reload, after a block is
 * dragged away, and after an estimate is raised — the three moments when a
 * planner most wants to quietly stop mentioning the work it dropped.
 */
export function unscheduled(
  tasks: PlannableTask[],
  blocks: { task_id: string | null; starts_at: string; ends_at: string }[],
  medians?: Map<string, number>,
): { task_id: string; minutes: number; guessed: boolean }[] {
  const planned = new Map<string, number>();
  for (const b of blocks) {
    if (!b.task_id) continue;
    planned.set(b.task_id, (planned.get(b.task_id) ?? 0) + blockMinutes(b));
  }

  return tasks
    .filter((t) => t.status !== "done")
    .map((t) => {
      const { minutes, guessed } = estimateFor(t, medians);
      return {
        task_id: t.id,
        minutes: Math.round(minutes - (planned.get(t.id) ?? 0)),
        guessed,
      };
    })
    // A minute or two of rounding slack is not an unplanned task. Anything
    // under the shortest session the planner would ever place is noise.
    .filter((t) => t.minutes >= MIN_SESSION_MINUTES / 4);
}

/* ---------------------------------------------------------------------------
   Presentation helpers — shared by the week grid, the cards and the form.
   ------------------------------------------------------------------------ */

/** `95` → `1h 35m`. The form the app says everywhere it says a duration. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}m`;
  if (!rest) return `${h}h`;
  return `${h}h ${rest}m`;
}

/** The compact form beside a due chip: `~2h`. */
export function formatEstimate(minutes: number): string {
  return `~${formatMinutes(minutes)}`;
}

export function blockMinutes(block: { starts_at: string; ends_at: string }): number {
  return (Date.parse(block.ends_at) - Date.parse(block.starts_at)) / MINUTE;
}

/** The clock on a block. Seconds never matter here and would only add noise. */
export function clockOf(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(":00", "");
}

/** Group blocks into the day columns they belong to. */
export function byDay<T extends { starts_at: string }>(
  blocks: T[],
  days: Date[],
): T[][] {
  const buckets: T[][] = days.map(() => []);
  const index = new Map(days.map((d, i) => [d.getTime(), i]));
  for (const b of blocks) {
    const d = new Date(b.starts_at);
    const i = index.get(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
    if (i !== undefined) buckets[i].push(b);
  }
  return buckets;
}

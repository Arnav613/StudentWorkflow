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

import type { PlanBlock, Routine, RoutineOverride, Task } from "./types";

/**
 * How far ahead the week looks, everywhere.
 *
 * Shared because three things have to agree on it: the grid's columns, the
 * horizon the calendar is fetched over, and how many days of a new routine get
 * written down. When they disagree the symptom is a routine that exists on
 * five of the seven columns you can see.
 */
export const PLAN_DAYS = 7;

/** Waking hours the planner is allowed to fill. Outside these it plans nothing. */
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 22;

/**
 * The grid every planned block lands on.
 *
 * A scheduler working to the minute produces a week of 5:18pm starts — each
 * one technically the earliest free moment, and all of them unreadable. Nobody
 * thinks in eighteens. Sessions begin on the half hour and last a whole number
 * of them, which costs a few minutes of theoretical packing efficiency and
 * buys a plan that can be held in your head.
 */
export const SLOT_MINUTES = 30;

/** Up to the next half hour. Used for starts: never earlier than allowed. */
export function snapUp(ms: number): number {
  const slot = SLOT_MINUTES * MINUTE;
  return Math.ceil(ms / slot) * slot;
}

/** To the closest half hour. Used where a person aimed, not where time began. */
export function snapNearest(ms: number): number {
  const slot = SLOT_MINUTES * MINUTE;
  return Math.round(ms / slot) * slot;
}

/** Minutes, to a whole number of half hours, never down to nothing. */
export function snapMinutes(minutes: number): number {
  return Math.max(SLOT_MINUTES, Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES);
}

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
 * The rounding floor beneath which a leftover is noise rather than work.
 *
 * The planner's real minimum sitting is one slot — see SLOT_MINUTES — since
 * everything it places lands on the half hour. This is only used to decide
 * when a few unaccounted minutes are worth calling unplanned, and a quarter of
 * it is well inside anybody's rounding error.
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
  /** Weekday exceptions to routine times. See migration 0008. */
  routineOverrides?: RoutineOverride[];
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

export type Interval = { start: number; end: number };

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
   Routines
   ------------------------------------------------------------------------ */

/** The weekday exceptions, keyed the way both callers want to ask. */
export function overrideIndex(
  overrides: RoutineOverride[],
): Map<string, RoutineOverride> {
  return new Map(overrides.map((o) => [`${o.routine_id}:${o.weekday}`, o]));
}

/**
 * When a routine happens on a given day, or null if it does not.
 *
 * One place, because there are now two callers that must agree exactly: the
 * planner generating a whole week, and the direct write that puts a new
 * routine straight onto the grid without waiting for Replan. Two
 * implementations of "when is gym on Tuesday" would drift, and the symptom
 * would be a block that moves the first time you press the button.
 */
export function routineTimeOn(
  routine: Routine,
  day: Date,
  overrides: Map<string, RoutineOverride>,
): { start: number; end: number } | null {
  if (!routine.active) return null;
  if (routine.weekday !== null && routine.weekday !== day.getDay()) return null;
  const override = overrides.get(`${routine.id}:${day.getDay()}`);
  const start = at(day, minutesOfDay(override?.time_of_day ?? routine.time_of_day));
  return { start, end: start + routine.duration_minutes * MINUTE };
}

/**
 * Every occurrence of one routine across a horizon, shaped for insert.
 *
 * `pinned` holds the dates this routine has already been placed by hand — a
 * block someone dragged. Those are left exactly alone: regenerating over the
 * top of a Tuesday you deliberately moved is the whole failure that locking
 * exists to prevent, and it would silently undo the "just this once" answer
 * the moment anything else changed.
 */
export function routineBlocks({
  routine,
  overrides,
  from,
  days,
  pinned = new Set<string>(),
}: {
  routine: Routine;
  overrides: Map<string, RoutineOverride>;
  from: Date;
  days: number;
  pinned?: Set<string>;
}): PlannedBlock[] {
  const out: PlannedBlock[] = [];
  const floor = from.getTime();

  for (const day of planDays(from, days)) {
    if (pinned.has(dayKey(day))) continue;
    const when = routineTimeOn(routine, day, overrides);
    // An hour that has already gone is not a commitment you can still keep, so
    // it neither renders nor blocks time.
    if (!when || when.end <= floor) continue;
    out.push({
      task_id: null,
      routine_id: routine.id,
      starts_at: new Date(when.start).toISOString(),
      ends_at: new Date(when.end).toISOString(),
      locked: false,
    });
  }
  return out;
}

/** A local calendar date as a string, for set membership. Never an instant. */
export function dayKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Where a block dropped between two neighbours should actually start.
 *
 * The rule the gesture implies, and the one it did not use to follow: a block
 * dropped into a gap starts *at that gap*, keeping its own length. Dragging an
 * 8am session to the end of Thursday used to keep 8am and snap back to the top
 * of the column — the app quietly overruling the only instruction the drag
 * carried.
 *
 * It takes only as long as it already took. A two-hour gap does not turn a
 * forty-minute reading into a two-hour reading; the rest of the gap stays free
 * for the planner.
 *
 * Overlap is permitted when the gap is genuinely too small. Refusing the drop
 * would be the app arguing with a deliberate act, and a double-booked hour you
 * created on purpose is information — one you were prevented from expressing
 * is not.
 */
export function timeForSlot({
  day,
  after,
  minutes,
}: {
  day: Date;
  /**
   * The item the block was dropped below, if any. The gap it opens is the
   * whole of the answer — the item *above* which the block was dropped is
   * deliberately not consulted, because the block keeps its own length either
   * way and shortening it to fit would silently rewrite an estimate, which is
   * the one number on a card the app is not allowed to invent.
   */
  after: { ends_at: string } | null;
  minutes: number;
}): Date {
  // The top of the gap, on the half hour. A block dropped into a two-hour hole
  // starts at the beginning of it rather than floating in the middle, so the
  // leftover time stays contiguous and the planner can still use it.
  const lower = after
    ? snapUp(Date.parse(after.ends_at))
    : at(day, DAY_START_HOUR * 60);

  // Pulled back only to keep the block inside the day it was dropped on. A gap
  // that is merely tight is left overlapping: refusing a deliberate drop would
  // be the app arguing with you, and a double-booked hour you created on
  // purpose is information.
  const dayEnd = at(day, 24 * 60);
  const start = Math.min(lower, snapNearest(dayEnd - minutes * MINUTE));
  return new Date(Math.max(start, at(day, 0)));
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
  routineOverrides = [],
  from,
  days = 7,
  medians,
}: PlanInput): Plan {
  const horizon = planDays(from, days);
  const floor = from.getTime();
  const ceiling = at(addDays(horizon[0], days - 1), DAY_END_HOUR * 60);

  const blocks: PlannedBlock[] = [];
  const occupied: Interval[] = [];

  /*
   * 1a. Routines, through the same generator the direct writes use.
   *
   * `pinned` is the "just this once" answer: a routine block someone dragged
   * is locked, is re-emitted by step 1b below exactly where they left it, and
   * must not also be generated here — that would put gym on Tuesday twice, at
   * five and at six, which is precisely the confusion moving it was meant to
   * resolve.
   */
  const overrides = overrideIndex(routineOverrides);
  const pinned = new Map<string, Set<string>>();
  for (const b of locked) {
    if (!b.routine_id) continue;
    const days = pinned.get(b.routine_id) ?? new Set<string>();
    days.add(dayKey(b.starts_at));
    pinned.set(b.routine_id, days);
  }

  for (const r of routines) {
    for (const block of routineBlocks({
      routine: r,
      overrides,
      from: horizon[0],
      days,
      pinned: pinned.get(r.id),
    })) {
      const start = Date.parse(block.starts_at);
      const end = Date.parse(block.ends_at);
      if (end <= floor) continue;
      blocks.push(block);
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
  windows.sort((a, b) => a.start - b.start);

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

      /*
       * Every session starts on the half hour and lasts a whole number of
       * them.
       *
       * Snapping the start forward can cost a few minutes off the front of a
       * window — the gap between a lecture ending at 10:50 and the next clean
       * slot at 11:00 is not a study session anyway, and the alternative was a
       * week of 10:50 and 5:18 starts that read as noise. The length rounds to
       * the nearest half hour rather than up, so an estimate is never quietly
       * inflated past what was typed.
       */
      const start = snapUp(w.start);
      if (start >= limit) continue;

      // Both ends on the grid, not just the start: a block running 9:00 to
      // 10:50 because that is when the lecture begins is the same unreadable
      // number in the other corner of the card.
      const room =
        Math.floor((limit - start) / MINUTE / SLOT_MINUTES) * SLOT_MINUTES;
      // A gap below one slot is a walk across campus, not a study session.
      if (room < SLOT_MINUTES) continue;

      const want = Math.min(remaining, MAX_SESSION_MINUTES);
      const length = Math.min(snapMinutes(want), room);
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
  now: number = Date.now(),
): { task_id: string; minutes: number; guessed: boolean; missed: boolean }[] {
  const planned = new Map<string, number>();
  const lapsed = new Set<string>();

  for (const b of blocks) {
    if (!b.task_id) continue;
    /*
     * An hour that has already gone by, on a task that is still not done, is
     * not planned time — it is the hour you did not use.
     *
     * This is the whole answer to "what happens to Tuesday's work if I skip
     * it". Nothing deletes it and nothing silently forgives it: the moment a
     * block lapses its minutes stop counting as accounted for, the task
     * reappears in the Unplanned rail carrying exactly what it still needs,
     * and the next Replan finds it a new hour. The alternative — counting
     * time you demonstrably did not spend — is a planner that quietly reports
     * a week as handled while the work piles up behind it.
     */
    if (Date.parse(b.ends_at) <= now) {
      lapsed.add(b.task_id);
      continue;
    }
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
        missed: lapsed.has(t.id),
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

/**
 * The clock on a block: `9 am`, `1:30 pm`.
 *
 * Twelve-hour, stated rather than inherited from the locale. Every other time
 * on the grid is one of these, and a browser set to a 24-hour locale used to
 * render half the app in one convention while the pickers spoke the other —
 * the same instant reading two different ways on one screen.
 *
 * `:00` is dropped and seconds never appear. A column seven wide has no room
 * to say "9:00 am" when it means nine.
 */
export function clockOf(iso: string | Date): string {
  return new Date(iso)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(":00", "")
    .toLowerCase();
}

/** `510` → `8:30 am`. The same clock, for a minutes-past-midnight value. */
export function clockOfMinutes(minutes: number): string {
  if (minutes >= 24 * 60) return "midnight";
  return clockOf(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));
}

/** Minutes past midnight → the `"HH:MM"` a TimePicker wants back. */
export function hhmmOf(minutes: number): string {
  const m = Math.min(minutes, 23 * 60 + 59);
  return `${`${Math.floor(m / 60)}`.padStart(2, "0")}:${`${m % 60}`.padStart(2, "0")}`;
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

/**
 * Board arrangement: which column a task sits in, and in what order.
 *
 * Kept out of the components on purpose. Ordering is the one rule on this
 * screen that has to be exactly right — an overdue essay buried under next
 * month's reading is the failure the whole app exists to prevent — and a pure
 * function is the version of it that can be reasoned about without a mounted
 * React tree.
 */

import type { HealthTask, Task, TaskStatus } from "./types";

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "Do" },
  { status: "doing", label: "Doing" },
  { status: "done", label: "Done" },
];

/** How long a finished task stays on the board before it is archived. */
export const ARCHIVE_AFTER_DAYS = 7;

export function isOverdue(task: Task, now = Date.now()): boolean {
  if (!task.due_at || task.status === "done") return false;
  return new Date(task.due_at).getTime() < now;
}

/**
 * Sort one column.
 *
 * Overdue first, then by due date ascending, then undated, then by position.
 *
 * The overdue pin is scoped to a task being overdue at all — which
 * `isOverdue` already reports as false for anything done — rather than to the
 * Do column by name. Same result today, and it stays right if a fourth column
 * ever appears.
 *
 * Undated tasks sort last rather than first: "sometime" should never outrank
 * "tomorrow". Among them `position` is the only signal, which is exactly the
 * tie-break the column was given a position for.
 */
export function sortColumn(tasks: Task[], now = Date.now()): Task[] {
  return [...tasks].sort((a, b) => {
    const ao = isOverdue(a, now);
    const bo = isOverdue(b, now);
    if (ao !== bo) return ao ? -1 : 1;

    if (a.due_at && b.due_at) {
      const diff = Date.parse(a.due_at) - Date.parse(b.due_at);
      if (diff !== 0) return diff;
    } else if (a.due_at !== b.due_at) {
      return a.due_at ? -1 : 1;
    }

    return a.position - b.position;
  });
}

/** Split the live task list into the three columns, each already sorted. */
export function groupByColumn(
  tasks: Task[],
  now = Date.now(),
): Record<TaskStatus, Task[]> {
  const out: Record<TaskStatus, Task[]> = { todo: [], doing: [], done: [] };
  for (const t of tasks) out[t.status].push(t);
  for (const key of Object.keys(out) as TaskStatus[]) {
    out[key] = sortColumn(out[key], now);
  }
  return out;
}

/**
 * Days left before a done task leaves the board, or null if it is not done.
 *
 * Shown on the card because silent disappearance is indistinguishable from a
 * bug. "Archives in 2 days" is the sentence that makes it a feature.
 */
export function daysUntilArchive(task: Task, now = Date.now()): number | null {
  if (task.status !== "done" || !task.completed_at) return null;
  const elapsed = now - Date.parse(task.completed_at);
  const left = ARCHIVE_AFTER_DAYS - elapsed / 86_400_000;
  return Math.max(0, Math.ceil(left));
}

/**
 * Midnight means "that day", not "that instant".
 *
 * A task given a date and no time is stored at 00:00 local, so every such
 * card used to read "Sat, 23 Aug, 12:00 AM" — a precise-looking timestamp
 * asserting a deadline nobody set. The clock is shown only when someone
 * actually put one there.
 */
function hasTime(d: Date): boolean {
  return d.getHours() !== 0 || d.getMinutes() !== 0;
}

function clockOf(d: Date): string {
  return d
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(":00", "");
}

/** Whole calendar days from today to `d` — 0 today, 1 tomorrow, -1 yesterday. */
function dayDelta(d: Date, now: Date): number {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

/**
 * The due date as a person would say it.
 *
 * Counted in calendar days rather than elapsed hours: something due at 9am
 * tomorrow is "Tomorrow" even though it is fourteen hours away, because that
 * is the answer to the question being asked. Past a week the relative form
 * stops helping — "in 23 days" is not a date anyone can plan around — so it
 * hands back to a real one.
 */
export function formatDue(due: string | null, now = new Date()): string {
  if (!due) return "No due date";
  const d = new Date(due);
  const delta = dayDelta(d, now);
  const clock = hasTime(d) ? `, ${clockOf(d)}` : "";

  if (delta === 0) return `Today${clock}`;
  if (delta === 1) return `Tomorrow${clock}`;
  if (delta === -1) return `Yesterday${clock}`;

  if (delta > 1 && delta < 7) {
    return `${d.toLocaleDateString(undefined, { weekday: "long" })}${clock}`;
  }
  if (delta < -1 && delta > -7) return `${-delta} days ago`;

  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * How late something is, for the overdue line. Separate from formatDue
 * because "Overdue · Yesterday" reads as a date and "3 days late" reads as a
 * problem, and only the second one is the point of the red text.
 */
export function formatLate(due: string | null, now = new Date()): string {
  if (!due) return "Overdue";
  const delta = -dayDelta(new Date(due), now);
  if (delta <= 0) return "Due today";
  if (delta === 1) return "1 day late";
  if (delta < 14) return `${delta} days late`;
  return `${Math.floor(delta / 7)} weeks late`;
}

/** The unambiguous form, for a title attribute. Nothing guessed, nothing hidden. */
export function formatDueExact(due: string | null): string {
  if (!due) return "No due date";
  const d = new Date(due);
  return d.toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(hasTime(d) ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/** The next thing due in a set of tasks, or null. Drives the class cards. */
export function nextDue(tasks: Task[]): Task | null {
  const live = tasks.filter((t) => t.status !== "done" && t.due_at);
  if (!live.length) return null;
  return live.reduce((best, t) =>
    Date.parse(t.due_at!) < Date.parse(best.due_at!) ? t : best,
  );
}

/* ---------------------------------------------------------------------------
   Class health
   ------------------------------------------------------------------------ */

/**
 * Below this many dated completions, the on-time rate is not reported.
 *
 * Two-for-two is 100%, and 100% next to a real 78% invites a comparison that
 * the numbers cannot support. A dash says "not yet" and is honest.
 */
export const MIN_RATED_COMPLETIONS = 5;

export type ClassHealth = {
  /** Everything ever recorded for the class, archived rows included. */
  total: number;
  done: number;
  /** Live tasks past their due date. The number that is actionable today. */
  overdue: number;
  /** Finished at or before the deadline, over finished-with-a-deadline. */
  onTimeRate: number | null;
};

/**
 * How a class is actually going.
 *
 * Reads `completed_at` against `due_at`, which is the reason done tasks are
 * archived rather than deleted — a week of visible history would make the
 * rate a rolling seven-day figure that swings on a single late reading.
 *
 * Only tasks that had a deadline count towards the rate: a task with no due
 * date cannot be finished late, and counting it as on time would let someone
 * lift the number by adding undated work.
 */
export function classHealth(
  tasks: HealthTask[],
  now = Date.now(),
): ClassHealth {
  let done = 0;
  let overdue = 0;
  let rated = 0;
  let onTime = 0;

  for (const t of tasks) {
    if (t.status === "done") done++;
    if (t.status !== "done" && t.due_at && Date.parse(t.due_at) < now) overdue++;
    if (t.status === "done" && t.completed_at && t.due_at) {
      rated++;
      if (Date.parse(t.completed_at) <= Date.parse(t.due_at)) onTime++;
    }
  }

  return {
    total: tasks.length,
    done,
    overdue,
    onTimeRate: rated >= MIN_RATED_COMPLETIONS ? onTime / rated : null,
  };
}

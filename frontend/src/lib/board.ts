/**
 * Board arrangement: which column a task sits in, and in what order.
 *
 * Kept out of the components on purpose. Ordering is the one rule on this
 * screen that has to be exactly right — an overdue essay buried under next
 * month's reading is the failure the whole app exists to prevent — and a pure
 * function is the version of it that can be reasoned about without a mounted
 * React tree.
 */

import type { Task, TaskStatus } from "./types";

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

export function formatDue(due: string | null): string {
  if (!due) return "No due date";
  return new Date(due).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

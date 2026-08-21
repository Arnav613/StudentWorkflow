/**
 * Board arrangement: which column a task sits in, and in what order.
 *
 * Kept out of the components on purpose. Ordering is the one rule on this
 * screen that has to be exactly right — an overdue essay buried under next
 * month's reading is the failure the whole app exists to prevent — and a pure
 * function is the version of it that can be reasoned about without a mounted
 * React tree.
 */

import type { HealthTask, Task, TaskGroup, TaskStatus } from "./types";

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
 * Sort one column: by `position`, and by nothing else.
 *
 * This used to pin overdue work to the top and then sort by due date, with
 * position as a tie-break among the undated. That default was right for a
 * board nobody had arranged; it is wrong for one somebody has. The order you
 * work in is not the order the deadlines fall in — the essay due Friday can
 * genuinely be the thing to start on Monday — and a column that quietly
 * re-sorted itself every time a deadline passed made saying so impossible.
 *
 * So the column is exactly what you left it as. Nothing on this board moves
 * unless a hand moved it. Overdue work is still marked in red on the card and
 * on the header of any group holding it, which is the honest version of the
 * pin: a warning you can see, not a rearrangement you did not ask for.
 *
 * The tie-breaks below are only ever reached by rows that arrived without an
 * order of their own — a Classroom import, or two writes racing. Deadline
 * first, then age, so even those land somewhere defensible rather than
 * somewhere random.
 */
export function sortColumn(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;

    if (a.due_at && b.due_at) {
      const diff = Date.parse(a.due_at) - Date.parse(b.due_at);
      if (diff !== 0) return diff;
    } else if (a.due_at !== b.due_at) {
      return a.due_at ? -1 : 1;
    }

    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

/** Split the live task list into the three columns, each already sorted. */
export function groupByColumn(tasks: Task[]): Record<TaskStatus, Task[]> {
  const out: Record<TaskStatus, Task[]> = { todo: [], doing: [], done: [] };
  for (const t of tasks) out[t.status].push(t);
  for (const key of Object.keys(out) as TaskStatus[]) {
    out[key] = sortColumn(out[key]);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Grouping
   ---------------------------------------------------------------------------
   Two ways of clustering the same cards, and neither of them changes a task.
   That is worth stating in the file rather than only in the schema: a group is
   a label, and the Week is drawn from estimates and blocks, so nothing here
   can reach it. Grouping eleven readings is a change to how a list reads and
   to nothing else.
   ------------------------------------------------------------------------ */

/** A row of the board: a loose card, or a group with its cards under it. */
export type BoardRow =
  | { kind: "task"; task: Task }
  | { kind: "group"; group: TaskGroup; tasks: Task[] };

/**
 * Cluster an already-sorted list into rows.
 *
 * A group appears where its *first* card would have appeared, and takes the
 * rest of its cards with it. In place, rather than lifted to the top of the
 * column: a group is a run of cards you put somewhere, and a header that
 * floated to the top of the column regardless would make dragging it there
 * meaningless — the one gesture this whole arrangement exists to support.
 *
 * A group whose cards are all elsewhere (another column, another class) does
 * not appear at all. An empty group header is a claim that something is here.
 */
export function cluster(
  sorted: Task[],
  groups: Map<string, TaskGroup>,
): BoardRow[] {
  const rows: BoardRow[] = [];
  const at = new Map<string, { kind: "group"; group: TaskGroup; tasks: Task[] }>();

  for (const task of sorted) {
    const group = task.group_id ? groups.get(task.group_id) : undefined;
    if (!group) {
      rows.push({ kind: "task", task });
      continue;
    }
    const open = at.get(group.id);
    if (open) {
      open.tasks.push(task);
      continue;
    }
    const row = { kind: "group" as const, group, tasks: [task] };
    at.set(group.id, row);
    rows.push(row);
  }

  return rows;
}

/**
 * The cards of a column in the order the eye reads them, groups unpacked.
 *
 * This is the list every drag is resolved against, and it is deliberately the
 * *displayed* order rather than the raw position order: `cluster` pulls a
 * group's stragglers up under its header, so the two can differ, and a drop
 * indicator drawn between two rows has to mean the gap the person is actually
 * looking at. Renumbering from this list is also what quietly repairs the
 * difference — after one drag, position order and reading order agree again.
 */
export function flatten(rows: BoardRow[]): Task[] {
  const out: Task[] = [];
  for (const row of rows) {
    if (row.kind === "task") out.push(row.task);
    else out.push(...row.tasks);
  }
  return out;
}

/**
 * Where something dropped into a column lands, as a set of new positions.
 *
 * Every row in the column is renumbered 1..n rather than the moved card being
 * given a fraction between its new neighbours. Fractions are the clever
 * version and they rot: enough drops between the same two cards and the gap
 * runs out of double precision, silently, months after the code was written.
 * A column is a few dozen rows on the worst week of a term, so the whole thing
 * is renumbered and only the rows whose number actually changed are written —
 * which for a drag two places up is three rows, not thirty.
 *
 * `moving` may be cards from another column, or a whole group's worth. They
 * are inserted in the order given and kept together.
 */
export function reorder(
  flat: Task[],
  moving: Task[],
  index: number,
): { id: string; position: number }[] {
  const ids = new Set(moving.map((t) => t.id));
  const rest = flat.filter((t) => !ids.has(t.id));

  // `index` was measured against the column as it looks on screen, which still
  // contains the cards being moved. Lifting them out shifts everything after
  // them up, so the same gap is that many slots earlier — without this, a card
  // dragged down two places lands one place short, every time.
  const lifted = flat.slice(0, index).filter((t) => ids.has(t.id)).length;
  const at = Math.max(0, Math.min(index - lifted, rest.length));
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];

  const updates: { id: string; position: number }[] = [];
  next.forEach((task, i) => {
    const position = i + 1;
    // Anything arriving from another column is written regardless: its old
    // number belonged to a different column and means nothing here.
    if (task.position !== position || ids.has(task.id)) {
      updates.push({ id: task.id, position });
    }
  });
  return updates;
}

/**
 * Where a brand-new task belongs in a hand-ordered column.
 *
 * By deadline — the sort this board used to do for everyone, now done exactly
 * once per task and never again. A task typed in on Monday for Friday lands
 * among Friday's work rather than at the bottom of a column somebody spent the
 * term arranging, and from that moment it stays where it is put.
 *
 * Undated work goes last, for the reason it always did: "sometime" should
 * never outrank "tomorrow". Cards inside groups are skipped as landing sites,
 * because a new task has not joined anybody's group — it is placed against the
 * loose cards and slots in beside the group its neighbours sit under.
 */
export function slotIndex(flat: Task[], dueAt: string | null): number {
  if (!dueAt) return flat.length;
  const due = Date.parse(dueAt);
  const found = flat.findIndex((t) => !t.due_at || Date.parse(t.due_at) > due);
  return found === -1 ? flat.length : found;
}

/**
 * The number to give a task nobody has placed yet.
 *
 * A fraction between its two new neighbours, rather than the renumber a drag
 * does. A drag is one gesture against a column somebody is looking at and can
 * afford to rewrite it; a task being created — by the form, by a scratch line
 * being promoted, by a click on an empty hour of the Week — is one insert that
 * must not turn into thirty writes on a page that is not even showing the
 * board. The halves accumulate only until the next drag through that gap,
 * which renumbers everything back to whole numbers.
 *
 * Called with the whole task list, because most of its callers are not the
 * board and have no business assembling a column. Raw position order is
 * correct here and grouping is not consulted: a new task is loose, and what it
 * needs is a number between two numbers.
 *
 * Every path that creates a task has to come through here. Leaving it out
 * means the column default of 0, which is *below every existing position* and
 * therefore the top of the column — the shape of bug that puts a note you
 * jotted at 2am above the essay due at nine.
 */
export function slotPosition(
  tasks: Task[],
  status: TaskStatus,
  dueAt: string | null,
): number {
  const column = sortColumn(tasks.filter((t) => t.status === status));
  const at = slotIndex(column, dueAt);
  const before = at > 0 ? column[at - 1].position : null;
  const after = at < column.length ? column[at].position : null;

  if (before === null) return after === null ? 1 : after - 1;
  if (after === null) return before + 1;
  // Equal neighbours mean a column the migration never numbered — a row two
  // creates raced on. Landing just after the first is as good an answer as
  // exists, and sortColumn's deadline tie-break decides the rest.
  return after > before ? (before + after) / 2 : before + 0.5;
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
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
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
    ...(hasTime(d)
      ? { hour: "numeric" as const, minute: "2-digit" as const, hour12: true }
      : {}),
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

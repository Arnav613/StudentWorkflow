export type TaskStatus = "todo" | "doing" | "done";
export type TaskSource = "manual" | "classroom";

export type Class = {
  id: string;
  user_id: string;
  name: string;
  color: string;
  professor: string | null;
  meeting_info: string | null;
  hidden: boolean;
  /** Null for every hand-made class. Set when imported from, or linked to, a course. */
  google_course_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  user_id: string;
  class_id: string | null;
  title: string;
  description: string | null;
  due_at: string | null;
  status: TaskStatus;
  source: TaskSource;
  position: number;
  completed_at: string | null;
  archived_at: string | null;
  /**
   * How long this takes, in minutes. Null is *unestimated* and never zero —
   * see migration 0005. The planner guesses a class median for a null and
   * says so in italics; a zero would occupy no time and then eat an evening.
   */
  estimate_minutes: number | null;
  google_coursework_id: string | null;
  google_course_id: string | null;
  status_overridden: boolean;
  auto_completed: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * A task reduced to what the class health cards compute over. The archive is
 * fetched as these columns alone — it grows all term and nothing on screen
 * needs its titles.
 */
export type HealthTask = Pick<
  Task,
  "class_id" | "status" | "due_at" | "completed_at"
>;

export type ChecklistItem = {
  id: string;
  user_id: string;
  task_id: string;
  label: string;
  done: boolean;
  position: number;
  created_at: string;
  updated_at: string;
};

/** Named rather than free-form so a class colour cannot drift to an unstyled value. */
export const CLASS_COLORS = [
  "slate",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

export type ClassColor = (typeof CLASS_COLORS)[number];

/**
 * A note. `content` is a BlockNote document — an array of blocks — stored as
 * jsonb rather than text or markdown, because the editor round-trips a tree
 * and flattening it on every save would quietly lose whatever markdown has no
 * syntax for (toggles, block ids, image widths).
 *
 * Typed `unknown[]` deliberately. BlockNote's own `Block[]` is generic over
 * the editor's schema, and pulling that type through the data layer would tie
 * every query in this file to the editor package. The editor validates its own
 * document on load; nothing else in the app reads inside a block.
 */
export type Note = {
  id: string;
  user_id: string;
  class_id: string;
  title: string;
  content: unknown[];
  created_at: string;
  updated_at: string;
};

/**
 * A link pinned to a class — syllabus, Drive folder, course page.
 *
 * `title` may be empty: pasting a URL and naming it later is the common
 * gesture, and refusing the paste until a name exists would put a form in
 * front of a one-second action. The UI falls back to the hostname.
 */
export type ClassLink = {
  id: string;
  user_id: string;
  class_id: string;
  title: string;
  url: string;
  position: number;
  /**
   * Null for a link a person pasted; set for one Classroom attached to a post.
   * Imported rows are never renamed or reordered by a sync — this is only how
   * the hourly job knows it has already written them.
   */
  google_material_id: string | null;
  /** Set only for Drive files, and the only rows that can be summarised. */
  google_drive_id: string | null;
  summary: string | null;
  summary_generated_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Something a model thinks, waiting for a person to agree.
 *
 * The app's one rule about AI, as a type: nothing a model produced writes a
 * due date, a grade or a task. It writes one of these, and a human turns it
 * into a task or throws it away. One hallucinated deadline that put itself on
 * a Tuesday would cost the credibility of every other date on the board.
 *
 * `payload` is deliberately loose. Each `kind` carries a different shape, and
 * a kind this build does not recognise must be skipped rather than crash the
 * queue — a newer backend can always be talking to an older tab.
 */
export type ProposalKind = "deadline";
export type ProposalStatus = "pending" | "accepted" | "rejected";

export type Proposal = {
  id: string;
  user_id: string;
  class_id: string | null;
  kind: ProposalKind;
  source_kind: "announcement";
  source_id: string;
  payload: Record<string, unknown>;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
};

/** A `kind: "deadline"` payload, once it has been checked rather than assumed. */
export type DeadlinePayload = {
  title: string;
  due_date: string;
  excerpt: string;
  announcement_url: string | null;
  class_name: string | null;
};

/**
 * Read a payload, or decline to.
 *
 * Returns null for anything malformed instead of throwing. A proposal is the
 * one row in this app written from model output, and the queue that renders
 * it must be the one place that never assumes the shape it was promised.
 */
export function deadlinePayload(p: Proposal): DeadlinePayload | null {
  if (p.kind !== "deadline") return null;
  const raw = p.payload ?? {};
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const due = typeof raw.due_date === "string" ? raw.due_date : "";
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  return {
    title,
    due_date: due,
    excerpt: typeof raw.excerpt === "string" ? raw.excerpt : "",
    announcement_url:
      typeof raw.announcement_url === "string" ? raw.announcement_url : null,
    class_name: typeof raw.class_name === "string" ? raw.class_name : null,
  };
}

/**
 * Something that occupies time every week but is not work: gym, laundry, a
 * standing rehearsal.
 *
 * Not a task, deliberately. Routines never reach the board, never complete
 * and never archive — they exist so the planner knows which hours are already
 * gone. See migration 0005 for why that is a separate table rather than a
 * recurring task.
 *
 * `weekday` null means daily; 0–6 is Sunday–Saturday, matching `Date#getDay`.
 * `time_of_day` is local wall-clock "HH:MM:SS", not an instant: 7am is 7am
 * wherever you are.
 */
export type Routine = {
  id: string;
  user_id: string;
  title: string;
  weekday: number | null;
  time_of_day: string;
  duration_minutes: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * One weekday of one routine, at a different time from the rest of it.
 *
 * "Gym at five, except Tuesdays, which are six." Without this there were two
 * answers and both were wrong: move the routine and every day moves with it,
 * or leave it and the plan is wrong every Tuesday until you fix it by hand.
 *
 * Only the weekday scope needs a row. A single occurrence is expressed by
 * locking its block, which is what locked already means everywhere else in
 * this app, and the whole routine is expressed by the routine itself. See
 * migration 0008.
 */
export type RoutineOverride = {
  id: string;
  user_id: string;
  routine_id: string;
  weekday: number;
  /** Null only when `skipped` — the day is cancelled, not moved. */
  time_of_day: string | null;
  /** "Never on a Tuesday", which is as much an exception as "later". */
  skipped: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * One occurrence of a routine that is not happening.
 *
 * A move can express "just this once" by locking its block, because the block
 * survives to carry the flag. A skip cannot — the block is gone — so something
 * has to remember it should stay gone the next time the week is planned.
 *
 * A local calendar date, never an instant: "not going on the 24th" is a
 * statement about a day in the city you are standing in.
 */
export type RoutineSkip = {
  id: string;
  user_id: string;
  routine_id: string;
  on_date: string;
  created_at: string;
};

/**
 * One hour of the week, spoken for. Exactly one of `task_id`, `routine_id` and
 * `google_event_id` is set — work, a standing commitment, or a lecture.
 *
 * `locked` means a person put this block here. Regeneration rewrites unlocked
 * blocks and plans around locked ones, which is the whole reason a manual
 * edit is not simply overwritten by the next press of the button.
 *
 * Event blocks are a *mirror* of Google, not a second source of truth: their
 * times are refreshed from the calendar on every open (see `db.syncCalendar`)
 * and nothing is ever written back. What the mirror adds is the two facts
 * Google has no opinion about — `dismissed`, meaning you are not going, and a
 * `locked` time you moved on your own board.
 */
export type PlanBlock = {
  id: string;
  user_id: string;
  task_id: string | null;
  routine_id: string | null;
  google_event_id: string | null;
  /** Set on event blocks only. A task block reads its title off the task. */
  title: string | null;
  starts_at: string;
  ends_at: string;
  locked: boolean;
  /**
   * Dropped from the board but kept on the row. Deleting instead would be
   * undone by the next refresh from Google — which reads as the app ignoring
   * you. A dismissed event occupies no time and waits in the Unplanned rail.
   */
  dismissed: boolean;
  created_at: string;
  updated_at: string;
};

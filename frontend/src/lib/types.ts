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
  google_coursework_id: string | null;
  google_course_id: string | null;
  status_overridden: boolean;
  auto_completed: boolean;
  created_at: string;
  updated_at: string;
};

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
  created_at: string;
  updated_at: string;
};

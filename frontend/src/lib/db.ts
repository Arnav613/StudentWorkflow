/**
 * Data access, straight from the browser to Supabase.
 *
 * Deliberately not routed through FastAPI. Render's free tier sleeps, so a
 * round trip through it would put a ~30s cold start in front of "add task" —
 * the single most frequent action in the app. RLS enforces exactly the
 * ownership rule an API layer would, so the API buys nothing here. FastAPI
 * keeps the work that genuinely needs a server: Classroom sync, refresh
 * tokens, the hourly cron, AI later.
 *
 * Every write below omits user_id. It is not forgotten — the RLS policies use
 * `auth.uid()`, and the column defaults are set from the session, so passing
 * it from the client would be both redundant and the wrong place to trust it.
 */

import { supabase } from "./supabase";
import type { Class, ChecklistItem, ClassLink, Task, TaskStatus } from "./types";

function unwrap<T>({ data, error }: { data: T | null; error: unknown }): T {
  if (error) throw error;
  return data as T;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export async function listClasses(includeHidden = false): Promise<Class[]> {
  let q = supabase.from("classes").select("*").order("name");
  if (!includeHidden) q = q.eq("hidden", false);
  return unwrap(await q);
}

export async function createClass(input: {
  user_id: string;
  name: string;
  color?: string;
  professor?: string | null;
  meeting_info?: string | null;
  /**
   * Linking at creation time, from the picker on the new-class form.
   *
   * Sync can also link a class it did not create, but only by matching names
   * exactly — so a course called "CS-2212 (Monsoon 2026)" never finds the
   * class you named "Algorithms". Choosing the course here is the version
   * that does not depend on guessing what you would have typed.
   */
  google_course_id?: string | null;
}): Promise<Class> {
  return unwrap(
    await supabase.from("classes").insert(input).select().single(),
  );
}

export async function updateClass(
  id: string,
  patch: Partial<Pick<Class, "name" | "color" | "professor" | "meeting_info" | "hidden">>,
): Promise<Class> {
  return unwrap(
    await supabase.from("classes").update(patch).eq("id", id).select().single(),
  );
}

export async function deleteClass(id: string): Promise<void> {
  const { error } = await supabase.from("classes").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Removing a class
// ---------------------------------------------------------------------------

/**
 * Remove a class for good: its tasks go with it (the foreign key cascades),
 * and if it came from Classroom the course is tombstoned so the next sync
 * does not import it straight back.
 *
 * The tombstone is written *before* the delete. Getting that order wrong
 * leaves a window where the class is gone but nothing remembers it was
 * refused — and a sync landing in that window undoes the whole thing.
 *
 * `dismissed_courses` is deliberately invisible in the UI: it is plumbing that
 * makes a deletion stick, not a recycle bin. It holds a course id and name and
 * nothing else. Undoing one is a delete in the SQL editor.
 */
export async function removeClass(
  c: Pick<Class, "id" | "name" | "google_course_id"> & { user_id: string },
): Promise<void> {
  if (c.google_course_id) {
    const { error } = await supabase.from("dismissed_courses").upsert(
      {
        user_id: c.user_id,
        google_course_id: c.google_course_id,
        name: c.name,
      },
      { onConflict: "user_id,google_course_id" },
    );
    if (error) throw error;
  }
  await deleteClass(c.id);
}


// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * The board query. Archived tasks are excluded here, not deleted anywhere —
 * a finished task is a few hundred bytes and grade tracking wants it later.
 *
 * Sorting is due date first, with nulls last: an undated task should never
 * outrank something due tomorrow. Overdue-pinning is a phase 03 board
 * concern, applied on top of this ordering rather than baked into it.
 */
export async function listTasks(): Promise<Task[]> {
  return unwrap(
    await supabase
      .from("tasks")
      .select("*")
      .is("archived_at", null)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("position", { ascending: true }),
  );
}

/**
 * Sweep finished tasks off the board a week after they were completed.
 *
 * Archived, never deleted: `archived_at` is set, the row stays. A finished
 * task is a few hundred bytes, and grade tracking wants that history later.
 *
 * Run on load rather than by cron. Phase 04 brings a scheduler, but this
 * belongs to the person looking at the board, not to a server — if nobody
 * opens the app for a month there is nothing to tidy, and a sweep that only
 * ever runs while someone is watching can never surprise them by having
 * cleared the board overnight. It is one indexed UPDATE and the common case
 * touches no rows.
 */
export async function archiveCompleted(
  afterDays = 7,
): Promise<number> {
  const cutoff = new Date(Date.now() - afterDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("tasks")
    .update({ archived_at: new Date().toISOString() })
    .eq("status", "done")
    .is("archived_at", null)
    .lt("completed_at", cutoff)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function createTask(input: {
  user_id: string;
  title: string;
  description?: string | null;
  due_at?: string | null;
  class_id?: string | null;
  status?: TaskStatus;
}): Promise<Task> {
  // source is left to the column default of 'manual'. The backend sync is the
  // only thing that ever writes 'classroom', and it writes it explicitly.
  return unwrap(await supabase.from("tasks").insert(input).select().single());
}

export async function updateTask(
  id: string,
  patch: Partial<
    Pick<Task, "title" | "description" | "due_at" | "class_id" | "status" | "position">
  >,
): Promise<Task> {
  return unwrap(
    await supabase.from("tasks").update(patch).eq("id", id).select().single(),
  );
}

/**
 * Moving a task by hand.
 *
 * `status_overridden` is the flag that stops sync fighting you, and it is set
 * far more narrowly than "the user touched this card". It means one specific
 * thing: *you disagreed with a decision sync made*. So it is written only
 * when a card that sync marked Done is dragged back out of Done.
 *
 * Setting it on every move would be the obvious version and the wrong one:
 * dragging a fresh task Do → Doing is ordinary work, not an argument, and
 * treating it as one would permanently stop that task ever auto-completing
 * when you submit it on Classroom. The flag is never cleared once set —
 * having stated a preference, you should not have to keep restating it.
 *
 * `position` is optional because it is only a tie-break: columns sort by due
 * date, so dropping a dated task anywhere in a column lands it where its
 * deadline says. Undated tasks are the only ones this argument moves.
 *
 * completed_at and archived_at are not written here — a database trigger sets
 * completed_at on the way into 'done' and clears both on the way out, so
 * dragging a card off Done also takes it back out of the archive queue.
 */
export async function moveTask(
  task: Task,
  status: TaskStatus,
  position?: number,
): Promise<Task> {
  const patch: Record<string, unknown> = { status };
  if (position !== undefined) patch.position = position;
  if (task.auto_completed && status !== "done") patch.status_overridden = true;
  return unwrap(
    await supabase.from("tasks").update(patch).eq("id", task.id).select().single(),
  );
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Checklist items — always hand-added, never generated.
// ---------------------------------------------------------------------------

export async function listChecklistItems(taskId: string): Promise<ChecklistItem[]> {
  return unwrap(
    await supabase
      .from("checklist_items")
      .select("*")
      .eq("task_id", taskId)
      .order("position"),
  );
}

export async function createChecklistItem(input: {
  user_id: string;
  task_id: string;
  label: string;
  position: number;
}): Promise<ChecklistItem> {
  return unwrap(
    await supabase.from("checklist_items").insert(input).select().single(),
  );
}

export async function updateChecklistItem(
  id: string,
  patch: Partial<Pick<ChecklistItem, "label" | "done" | "position">>,
): Promise<ChecklistItem> {
  return unwrap(
    await supabase.from("checklist_items").update(patch).eq("id", id).select().single(),
  );
}

export async function deleteChecklistItem(id: string): Promise<void> {
  const { error } = await supabase.from("checklist_items").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Class links — the Docs tab. See migration 0004.
// ---------------------------------------------------------------------------

export async function listClassLinks(classId: string): Promise<ClassLink[]> {
  return unwrap(
    await supabase
      .from("class_links")
      .select("*")
      .eq("class_id", classId)
      .order("position"),
  );
}

/**
 * Save a link.
 *
 * The URL is normalised here rather than in the database: someone pasting
 * `drive.google.com/...` without a scheme means https, and storing it raw
 * would produce an anchor the browser resolves against our own origin — a
 * link that silently goes nowhere. A check constraint cannot fix that up, it
 * can only reject it.
 */
export async function createClassLink(input: {
  user_id: string;
  class_id: string;
  title: string;
  url: string;
  position: number;
}): Promise<ClassLink> {
  return unwrap(
    await supabase
      .from("class_links")
      .insert({ ...input, url: normaliseUrl(input.url) })
      .select()
      .single(),
  );
}

export async function updateClassLink(
  id: string,
  patch: Partial<Pick<ClassLink, "title" | "url" | "position">>,
): Promise<ClassLink> {
  const next = patch.url ? { ...patch, url: normaliseUrl(patch.url) } : patch;
  return unwrap(
    await supabase.from("class_links").update(next).eq("id", id).select().single(),
  );
}

export async function deleteClassLink(id: string): Promise<void> {
  const { error } = await supabase.from("class_links").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Assume https for a bare host, and leave anything with a scheme alone.
 *
 * Only http and https survive. A `javascript:` or `data:` URL typed into this
 * box would otherwise become a link the user clicks in their own session —
 * the anchor carries rel="noreferrer" either way, but neither of those
 * schemes is a document and both are a script-execution vector.
 */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return `https://${trimmed}`;
  return /^https?:/i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^[^:]+:\/*/, "")}`;
}

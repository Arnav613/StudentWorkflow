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
import type { Class, ChecklistItem, Task, TaskStatus } from "./types";

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

/**
 * Hiding, not deleting, is the normal way to retire a class — deleting one
 * nulls class_id on its tasks and loses the association permanently.
 */
export async function setClassHidden(id: string, hidden: boolean): Promise<Class> {
  return updateClass(id, { hidden });
}

export async function deleteClass(id: string): Promise<void> {
  const { error } = await supabase.from("classes").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * The board query. Archived tasks are excluded here, not deleted anywhere —
 * a finished task is a few hundred bytes and grade tracking wants it later.
 *
 * Sorting is due date first, with nulls last: an undated task should never
 * outrank something due tomorrow. Overdue-pinning is a phase 02 board
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

export async function createTask(input: {
  user_id: string;
  title: string;
  description?: string | null;
  due_at?: string | null;
  class_id?: string | null;
  status?: TaskStatus;
}): Promise<Task> {
  // source is left to the column default of 'manual'. Phase 05 is the only
  // thing that ever writes 'classroom', and it writes it explicitly.
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
 * Sets status_overridden so a later Classroom sync will not drag the card
 * back where it thinks it belongs. Harmless on manual tasks, which sync never
 * touches; essential on imported ones. Writing it here rather than in phase
 * 05 means there is one move-a-task path, not two that must agree.
 */
export async function moveTask(id: string, status: TaskStatus): Promise<Task> {
  return unwrap(
    await supabase
      .from("tasks")
      .update({ status, status_overridden: true })
      .eq("id", id)
      .select()
      .single(),
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

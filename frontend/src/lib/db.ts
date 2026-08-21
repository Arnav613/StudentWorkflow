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
 * Every write below passes user_id explicitly, and must. The RLS policies are
 * `with check (auth.uid() = user_id)`, and no table in this schema defaults the
 * column to `auth.uid()` — so an insert that leaves it out is not defaulted, it
 * is rejected. A version of this comment used to claim the opposite, which cost
 * phase 10 an afternoon: the policy checks the column, and something has to put
 * a value in it.
 */

import { supabase } from "./supabase";
import type {
  Class,
  CalendarSeries,
  ChecklistItem,
  ClassDocument,
  ClassEventLink,
  ClassLink,
  ClassSession,
  DocumentKind,
  DeadlinePayload,
  HealthTask,
  Proposal,
  PlanBlock,
  Routine,
  RoutineOverride,
  RoutineSkip,
  Rubric,
  RubricCriterion,
  Task,
  TaskStatus,
} from "./types";
import { dayKey, overrideIndex, routineBlocks } from "./schedule";
import type { PlannedBlock } from "./schedule";

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
 * The archive, for the health cards only.
 *
 * `listTasks` deliberately excludes archived rows — they are history, not
 * board state — but an on-time rate computed from the last seven days is a
 * rate that swings on one late reading. So the history is fetched separately,
 * with only the four columns the arithmetic touches: this list grows all term
 * and nothing on the screen needs its titles.
 */
export async function listArchivedTasks(): Promise<HealthTask[]> {
  return unwrap(
    await supabase
      .from("tasks")
      .select("class_id, status, due_at, completed_at")
      .not("archived_at", "is", null),
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
  estimate_minutes?: number | null;
}): Promise<Task> {
  // source is left to the column default of 'manual'. The backend sync is the
  // only thing that ever writes 'classroom', and it writes it explicitly.
  return unwrap(await supabase.from("tasks").insert(input).select().single());
}

export async function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | "title"
      | "description"
      | "due_at"
      | "class_id"
      | "status"
      | "position"
      | "estimate_minutes"
    >
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

/**
 * The same edit, to several tasks, in one statement.
 *
 * A loop of `updateTask` would do it and would be wrong in two ways: it is a
 * round trip per card, so a selection of twelve visibly repaints twelve times,
 * and it can fail halfway and leave half the selection changed with no record
 * of which half. One `in` clause is atomic enough for what this is.
 *
 * Deliberately narrower than `updateTask`. Title and description are the two
 * fields nobody has ever wanted to set to the same value across a selection,
 * and offering them would only make "apply to all" a way to lose eleven
 * titles.
 */
export async function updateTasks(
  ids: string[],
  patch: Partial<Pick<Task, "class_id" | "status" | "estimate_minutes" | "due_at">>,
): Promise<Task[]> {
  if (!ids.length) return [];
  return unwrap(
    await supabase.from("tasks").update(patch).in("id", ids).select(),
  );
}

/**
 * Move several tasks to a column at once.
 *
 * Split from `updateTasks` for the one reason `moveTask` exists at all:
 * `status_overridden`, which must be set on exactly the rows sync had marked
 * Done and on no others. That is two statements rather than one, and the
 * alternative — setting the flag across the whole selection — would quietly
 * stop every card in it from ever auto-completing again.
 */
export async function moveTasks(
  tasks: Task[],
  status: TaskStatus,
): Promise<Task[]> {
  if (!tasks.length) return [];

  const arguing = tasks
    .filter((t) => t.auto_completed && status !== "done")
    .map((t) => t.id);
  if (arguing.length) {
    unwrap(
      await supabase
        .from("tasks")
        .update({ status_overridden: true })
        .in("id", arguing)
        .select(),
    );
  }

  return unwrap(
    await supabase
      .from("tasks")
      .update({ status })
      .in("id", tasks.map((t) => t.id))
      .select(),
  );
}

export async function deleteTasks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase.from("tasks").delete().in("id", ids);
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

// ---------------------------------------------------------------------------
// Proposals — phase 09. See migration 0010.
// ---------------------------------------------------------------------------

/**
 * The review queue: what a model has suggested and nobody has answered yet.
 *
 * Almost always empty, which is why this is a panel and not a tab. It is
 * fetched on its own rather than joining `useData`'s shared load — the queue
 * is a small, rare list with its own lifecycle, and putting it in the
 * five-query load would make every board refresh pay for a table that is
 * usually zero rows.
 */
export async function listPendingProposals(): Promise<Proposal[]> {
  return unwrap(
    await supabase
      .from("proposals")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
  );
}

/**
 * Yes: turn a proposal into a real task.
 *
 * Through `db.createTask`, the same function the New task form uses, and
 * deliberately not through a path of its own. The moment this row becomes a
 * task it stops being model output and becomes the user's — `source` is left
 * to its default of 'manual', because a person typed nothing here but a
 * person did decide it, and 'classroom' would hand Classroom's sync the right
 * to overwrite a title and date Classroom has never heard of.
 *
 * Midnight, like every hand-made whole-day deadline: due by the end of that
 * day. An announcement almost never states a time, and inventing 5pm would be
 * the model's guess wearing a person's approval.
 */
export async function acceptProposal(
  p: Proposal,
  payload: DeadlinePayload,
  userId: string,
): Promise<Task> {
  const task = await createTask({
    user_id: userId,
    title: payload.title,
    class_id: p.class_id,
    due_at: new Date(`${payload.due_date}T00:00`).toISOString(),
  });

  // After the insert, never before. A decided proposal whose task failed to
  // write is a deadline that has silently vanished — the worst outcome this
  // feature has — while a task whose proposal is still pending is one stale
  // card in a queue, fixed by pressing the same button again.
  await decide(p.id, "accepted");
  return task;
}

/**
 * No, and remember it.
 *
 * The row is kept rather than deleted, and that is the whole mechanism: the
 * unique index on (user_id, source_kind, source_id, kind) means the next sync
 * that re-reads this announcement cannot insert a second proposal for it. A
 * delete would make "no" a thing the app asks you again every hour.
 */
export async function rejectProposal(id: string): Promise<void> {
  await decide(id, "rejected");
}

async function decide(id: string, status: "accepted" | "rejected"): Promise<void> {
  const { error } = await supabase
    .from("proposals")
    .update({ status, decided_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * A summary, written back into the row the backend already cached it in.
 *
 * The route persists it server-side; this exists so the open Docs tab shows
 * the text without a refetch. Nothing here calls a model.
 */
export function withSummary(
  links: ClassLink[],
  id: string,
  summary: string,
  generatedAt: string | null,
): ClassLink[] {
  return links.map((l) =>
    l.id === id
      ? { ...l, summary, summary_generated_at: generatedAt ?? l.summary_generated_at }
      : l,
  );
}

// ---------------------------------------------------------------------------
// Routines — phase 07. See migration 0005.
// ---------------------------------------------------------------------------

/**
 * Every routine, active or not.
 *
 * Inactive ones are still fetched because the only place they can be turned
 * back on is the list that would otherwise hide them — filtering here would
 * make "paused" indistinguishable from "deleted".
 */
export async function listRoutines(): Promise<Routine[]> {
  return unwrap(
    await supabase.from("routines").select("*").order("time_of_day"),
  );
}

export async function createRoutine(input: {
  user_id: string;
  title: string;
  weekday: number | null;
  time_of_day: string;
  duration_minutes: number;
}): Promise<Routine> {
  return unwrap(await supabase.from("routines").insert(input).select().single());
}

export async function updateRoutine(
  id: string,
  patch: Partial<
    Pick<Routine, "title" | "weekday" | "time_of_day" | "duration_minutes" | "active">
  >,
): Promise<Routine> {
  return unwrap(
    await supabase.from("routines").update(patch).eq("id", id).select().single(),
  );
}

export async function deleteRoutine(id: string): Promise<void> {
  const { error } = await supabase.from("routines").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Plan blocks
// ---------------------------------------------------------------------------

/**
 * The plan from a given instant onward.
 *
 * Past blocks are not fetched and not shown. The week grid is a decision about
 * what happens next; yesterday's blocks are neither actionable nor
 * interesting, and keeping them on screen would mean the first two columns of
 * every week were history.
 *
 * They are not deleted either — regeneration only ever touches the future, so
 * a plan you kept to is still on the row if the forecast in phase 08 wants it.
 */
export async function listPlanBlocks(from: Date): Promise<PlanBlock[]> {
  return unwrap(
    await supabase
      .from("plan_blocks")
      .select("*")
      .gte("ends_at", from.toISOString())
      .order("starts_at"),
  );
}

/**
 * Add hours to the plan. Never take any away.
 *
 * This is the whole of Autoplan's write path, and the reason it is an insert
 * and not a replace. The button used to be Replan, which deleted every
 * unlocked block from here on and rebuilt the week from scratch — so a plan
 * you had read, agreed with and half worked through could be silently
 * rearranged by one press, and the only defence against that was `locked`,
 * a flag nobody could see and nobody set on purpose.
 *
 * Autoplan does the smaller, honest thing instead: it looks at what is already
 * on the grid, treats every hour of it as spoken for, and fills the gaps that
 * are left with work that had no hour against it. Pressing it can add blocks
 * to your week. It cannot move one and it cannot remove one. Everything that
 * takes an hour off the grid is a thing you did — a drag, a delete, or a diff
 * you accepted.
 */
export async function addPlanBlocks(
  userId: string,
  blocks: PlannedBlock[],
): Promise<PlanBlock[]> {
  if (!blocks.length) return [];

  return unwrap(
    await supabase
      .from("plan_blocks")
      .insert(blocks.map((b) => ({ ...b, user_id: userId })))
      .select(),
  );
}

/**
 * Move or resize a block by hand — which locks it, always.
 *
 * `locked` is not a checkbox the user has to find. Touching a block *is* the
 * statement that this one is yours now, and the next regeneration plans
 * around it. Making it opt-in would mean every manual edit survives until the
 * moment you press the button that silently undoes all of them.
 */
export async function moveBlock(
  id: string,
  starts_at: string,
  ends_at: string,
): Promise<PlanBlock> {
  return unwrap(
    await supabase
      .from("plan_blocks")
      .update({ starts_at, ends_at, locked: true })
      .eq("id", id)
      .select()
      .single(),
  );
}

/**
 * Move a block without claiming a person meant to.
 *
 * `moveBlock` locks, because a drag is somebody saying "here, and leave it
 * here". A block shoved later to make room for that drag is saying nothing at
 * all — it is a consequence — and locking it would pin an entire evening to the
 * wall every time one task was dropped into the middle of it, with Replan then
 * refusing to tidy any of it up.
 */
export async function shiftBlock(
  id: string,
  starts_at: string,
  ends_at: string,
): Promise<PlanBlock> {
  return unwrap(
    await supabase
      .from("plan_blocks")
      .update({ starts_at, ends_at })
      .eq("id", id)
      .select()
      .single(),
  );
}

/** Hand a locked block back to the planner. */
export async function unlockBlock(id: string): Promise<PlanBlock> {
  return unwrap(
    await supabase
      .from("plan_blocks")
      .update({ locked: false })
      .eq("id", id)
      .select()
      .single(),
  );
}

export async function deleteBlock(id: string): Promise<void> {
  const { error } = await supabase.from("plan_blocks").delete().eq("id", id);
  if (error) throw error;
}

/** Several blocks off the grid at once. Same reasoning as `deleteTasks`. */
export async function deleteBlocks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase.from("plan_blocks").delete().in("id", ids);
  if (error) throw error;
}

/** Several lectures dropped at once. A mirror row is dismissed, never deleted. */
export async function setDismissedMany(
  ids: string[],
  dismissed: boolean,
): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase
    .from("plan_blocks")
    .update({ dismissed })
    .in("id", ids);
  if (error) throw error;
}

/**
 * Place a block by hand — a task dragged out of the Unplanned rail onto a day.
 *
 * Locked on arrival, like every other manual placement. Someone chose this
 * hour, and the next Replan has to work around it rather than treat it as one
 * of its own suggestions to reshuffle.
 */
export async function createTaskBlock(input: {
  user_id: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
}): Promise<PlanBlock> {
  return unwrap(
    await supabase
      .from("plan_blocks")
      .insert({ ...input, locked: true })
      .select()
      .single(),
  );
}

/**
 * Take a lecture off the board, or put it back.
 *
 * A flag rather than a delete, because the row is a mirror: deleting it would
 * last exactly until the next refresh from Google, which reads as the app
 * ignoring you. Dismissed is also never written back to the calendar — "I am
 * not going to this" is a decision about your week, not an announcement to
 * everyone else on the invite.
 */
export async function setDismissed(
  id: string,
  dismissed: boolean,
): Promise<PlanBlock> {
  return unwrap(
    await supabase
      .from("plan_blocks")
      .update({ dismissed })
      .eq("id", id)
      .select()
      .single(),
  );
}

// ---------------------------------------------------------------------------
// The calendar mirror
// ---------------------------------------------------------------------------

export type MirrorEvent = {
  id: string;
  /**
   * The recurring event this occurrence belongs to, or its own id for a
   * one-off. Mirrored onto the block so the grid can look up which class a
   * lecture is without a second round trip — see `class_event_links`.
   */
  series_id?: string;
  title: string;
  starts_at: string;
  ends_at: string;
};

/**
 * Bring the local copy of the calendar in line with Google.
 *
 * Events used to be fetched on every open and drawn straight onto the grid,
 * owned by nobody. That cost a visible pause on a screen whose whole job is to
 * be glanced at, and it made a lecture the one thing on the board you could
 * not move — the grid rendered rows the app had no right to touch.
 *
 * Now they are rows here, rendered instantly from the same query as everything
 * else, and this runs *behind* that render. Google stays the source of truth
 * for when a lecture is; what it does not get an opinion on is the two things
 * this app added on top:
 *
 *   - a `locked` block keeps the time you dragged it to. You moved it on your
 *     board on purpose, and a refresh that dragged it back would be the app
 *     undoing your work every thirty seconds.
 *   - a `dismissed` block stays dismissed. You are still not going.
 *
 * Nothing here writes to Google. A cancelled lecture disappears because it
 * stops coming back from the fetch, not because anything told Google so.
 */
export async function syncCalendar(
  userId: string,
  events: MirrorEvent[],
  from: Date,
  /**
   * The far edge of the window Google was actually asked about.
   *
   * Used only to bound the cancelled-lecture sweep, never the identity
   * lookup. Getting those two the same way round is what caused
   * plan_blocks_event_idx to blow up: the mirror was searched over
   * midnight-to-midnight while the backend asks Google for now-to-now-plus-
   * seven, so every event in the sliver between the two came back looking
   * brand new, got inserted, and collided with the row already holding it.
   */
  to: Date,
): Promise<boolean> {
  // No upper bound. A lecture is the same lecture wherever it now sits — you
  // may have dragged it clean out of any window this query could guess at —
  // and an identity lookup that can miss is an identity lookup that duplicates.
  const existing: PlanBlock[] = unwrap(
    await supabase
      .from("plan_blocks")
      .select("*")
      .not("google_event_id", "is", null)
      .gte("ends_at", from.toISOString()),
  );

  const byEvent = new Map(existing.map((b) => [b.google_event_id as string, b]));
  // Google can hand back the same id twice across a page boundary when a
  // recurrence is edited mid-fetch. One row per id, always.
  const incoming = [...new Map(events.map((e) => [e.id, e])).values()];
  const seen = new Set(incoming.map((e) => e.id));
  let changed = false;

  const fresh = incoming
    .filter((e) => !byEvent.has(e.id))
    .map((e) => ({
      user_id: userId,
      google_event_id: e.id,
      google_series_id: e.series_id ?? e.id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      locked: false,
      dismissed: false,
    }));

  if (fresh.length) {
    /*
     * A plain insert, with one error forgiven by code.
     *
     * Not an upsert: plan_blocks_event_idx is a *partial* index, and Postgres
     * will not reliably infer a partial index as the arbiter for an explicit
     * ON CONFLICT target — the fix would fail exactly where the bug was.
     *
     * 23505 is unique_violation, and here it can only mean another tab
     * mirrored the same lecture a moment ago. The row it collided with is the
     * row this one wanted. Matched on the code rather than on the text of the
     * message, which is a sentence Postgres is free to reword.
     */
    const { error } = await supabase.from("plan_blocks").insert(fresh);
    if (error && error.code !== "23505") throw error;
    changed = true;
  }

  for (const event of incoming) {
    const block = byEvent.get(event.id);
    if (!block) continue;
    const patch: Record<string, string> = {};
    if (block.title !== event.title) patch.title = event.title;
    // Backfill. Every block mirrored before migration 0011 has a null series
    // id, and without this the class link would only ever work for lectures
    // first seen after the upgrade — the ones already on the grid would stay
    // permanently unlinkable with nothing to explain it.
    const series = event.series_id ?? event.id;
    if (block.google_series_id !== series) patch.google_series_id = series;
    // A moved lecture is only followed if you have not moved it yourself.
    if (!block.locked) {
      if (block.starts_at !== event.starts_at) patch.starts_at = event.starts_at;
      if (block.ends_at !== event.ends_at) patch.ends_at = event.ends_at;
    }
    if (!Object.keys(patch).length) continue;
    const { error } = await supabase
      .from("plan_blocks")
      .update(patch)
      .eq("id", block.id);
    if (error) throw error;
    changed = true;
  }

  /*
   * Gone from Google means cancelled. Dropping the local row is right even for
   * a dismissed one — you cannot skip a lecture that is not happening.
   *
   * Bounded by the window we asked about, unlike the lookup above: a lecture
   * three weeks out did not come back because nobody asked, and deleting it on
   * that basis would empty the mirror one horizon at a time.
   */
  const horizon = to.getTime();
  const stale = existing.filter(
    (b) =>
      !seen.has(b.google_event_id as string) && Date.parse(b.starts_at) <= horizon,
  );
  if (stale.length) {
    const { error } = await supabase
      .from("plan_blocks")
      .delete()
      .in("id", stale.map((b) => b.id));
    if (error) throw error;
    changed = true;
  }

  return changed;
}

/**
 * Throw away the local copy of the calendar and take Google's again.
 *
 * The ordinary sync deliberately preserves two things it finds locally: a
 * lecture you moved keeps your time, a lecture you dropped stays dropped.
 * That is right almost always and wrong exactly once — when the local copy has
 * drifted far enough from the real timetable that you would rather start over
 * than repair it block by block.
 *
 * So this is the one destructive path, and it is a button a person presses
 * rather than anything that happens on its own. Delete every mirrored event in
 * the horizon, insert what Google says now. Blocks for tasks and routines are
 * untouched — this resets the mirror, not the plan.
 */
export async function resyncCalendar(
  userId: string,
  events: MirrorEvent[],
  from: Date,
): Promise<void> {
  // Every mirrored event from `from` onward, with no upper bound — including
  // any you dragged past whatever edge a bounded delete would have used. This
  // is the statement "the local calendar is wrong, take Google's", and half of
  // it left standing is how the insert below hit plan_blocks_event_idx.
  const { error: delError } = await supabase
    .from("plan_blocks")
    .delete()
    .not("google_event_id", "is", null)
    .gte("ends_at", from.toISOString());
  if (delError) throw delError;

  const incoming = [...new Map(events.map((e) => [e.id, e])).values()];
  if (!incoming.length) return;

  const { error } = await supabase.from("plan_blocks").insert(
    incoming.map((e) => ({
      user_id: userId,
      google_event_id: e.id,
      google_series_id: e.series_id ?? e.id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      locked: false,
      dismissed: false,
    })),
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Routine overrides, and putting routines straight onto the grid
// ---------------------------------------------------------------------------

export async function listRoutineOverrides(): Promise<RoutineOverride[]> {
  return unwrap(await supabase.from("routine_overrides").select("*"));
}

/**
 * One weekday of one routine, at its own time — or not at all.
 *
 * Upserted: one rule per weekday, because two would be a coin toss over which
 * time Tuesday gets.
 */
export async function setRoutineOverride(input: {
  user_id: string;
  routine_id: string;
  weekday: number;
  time_of_day?: string | null;
  skipped?: boolean;
}): Promise<RoutineOverride> {
  return unwrap(
    await supabase
      .from("routine_overrides")
      .upsert(input, { onConflict: "routine_id,weekday" })
      .select()
      .single(),
  );
}

/**
 * Every exception, gone.
 *
 * Used when a time is set for the whole routine: a rule restated for all seven
 * days has nothing left to make an exception to, and leaving Tuesday's old
 * override standing would mean the one day that visibly refused the change.
 */
export async function clearRoutineOverrides(routineId: string): Promise<void> {
  const { error } = await supabase
    .from("routine_overrides")
    .delete()
    .eq("routine_id", routineId);
  if (error) throw error;
}

/**
 * Write a routine's occurrences onto the grid, now, without a Replan.
 *
 * A routine used to be a row you entered and then a button you pressed before
 * anything happened — which made it a setting rather than a thing you did, and
 * left the panel and the grid disagreeing about your week until you noticed.
 * Adding a routine, or moving one, now shows up where you are looking.
 *
 * Locked occurrences are preserved and planned around, not rewritten: a
 * Tuesday you dragged to six is the "just this once" answer, and regenerating
 * over the top of it would silently undo it.
 */
export async function listRoutineSkips(): Promise<RoutineSkip[]> {
  return unwrap(await supabase.from("routine_skips").select("*"));
}

/** One occurrence, not happening. Idempotent: skipping twice is still once. */
export async function addRoutineSkip(input: {
  user_id: string;
  routine_id: string;
  on_date: string;
}): Promise<void> {
  const { error } = await supabase
    .from("routine_skips")
    .upsert(input, { onConflict: "routine_id,on_date", ignoreDuplicates: true });
  if (error) throw error;
}

export async function resyncRoutine(
  userId: string,
  routine: Routine,
  overrides: RoutineOverride[],
  skips: RoutineSkip[],
  from: Date,
  days: number,
): Promise<PlanBlock[]> {
  const existing: PlanBlock[] = unwrap(
    await supabase
      .from("plan_blocks")
      .select("*")
      .eq("routine_id", routine.id)
      .gte("ends_at", from.toISOString()),
  );

  const doomed = existing.filter((b) => !b.locked).map((b) => b.id);
  if (doomed.length) {
    const { error } = await supabase.from("plan_blocks").delete().in("id", doomed);
    if (error) throw error;
  }

  const pinned = new Set(
    existing.filter((b) => b.locked).map((b) => dayKey(b.starts_at)),
  );
  const fresh = routineBlocks({
    routine,
    overrides: overrideIndex(overrides.filter((o) => o.routine_id === routine.id)),
    from,
    days,
    pinned,
    skipped: new Set(
      skips
        .filter((s) => s.routine_id === routine.id)
        .map((s) => dayKey(new Date(`${s.on_date}T00:00:00`))),
    ),
  });
  if (!fresh.length) return [];

  return unwrap(
    await supabase
      .from("plan_blocks")
      .insert(fresh.map((b) => ({ ...b, user_id: userId })))
      .select(),
  );
}

// ---------------------------------------------------------------------------
// Uploaded documents — phase 10. See migration 0011.
// ---------------------------------------------------------------------------
//
// The file goes to Storage from the browser, under the bucket's own policies,
// and the row is written from the browser too. The server's only part in this
// is reading the bytes back and asking Gemini what they say — it never writes
// a session, a criterion or a mark.

const DOCS_BUCKET = "class-docs";

export async function listClassDocuments(
  classId: string,
  kind: DocumentKind,
): Promise<ClassDocument[]> {
  return unwrap(
    await supabase
      .from("class_documents")
      .select("*")
      .eq("class_id", classId)
      .eq("kind", kind)
      .order("created_at", { ascending: false }),
  );
}

function extensionOf(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : "";
  if (fromName && /^[a-z0-9]{1,5}$/i.test(fromName)) return fromName.toLowerCase();
  const fromType = file.type.split("/")[1];
  return fromType === "jpeg" ? "jpg" : fromType || "bin";
}

/**
 * Upload a handout and record it, in that order.
 *
 * The object first, the row second, because the failure that matters is a row
 * pointing at a file that is not there — a tab listing a document which will
 * not open, forever. The other way round leaves an orphaned object in a
 * private bucket, which costs a few hundred kilobytes of a free gigabyte and
 * is invisible.
 *
 * Path is `<user_id>/<class_id>/<random>.<ext>`: the first segment is the
 * whole storage policy, the same rule note images have followed since 0003.
 */
export async function uploadClassDocument(input: {
  user_id: string;
  class_id: string;
  kind: DocumentKind;
  file: File;
}): Promise<ClassDocument> {
  const { user_id, class_id, kind, file } = input;
  const path = `${user_id}/${class_id}/${crypto.randomUUID()}.${extensionOf(file)}`;

  const { error } = await supabase.storage
    .from(DOCS_BUCKET)
    .upload(path, file, { contentType: file.type || undefined });
  if (error) throw error;

  return unwrap(
    await supabase
      .from("class_documents")
      .insert({
        user_id,
        class_id,
        kind,
        title: file.name.slice(0, 200),
        storage_path: path,
        mime_type: file.type || "application/octet-stream",
      })
      .select()
      .single(),
  );
}

/**
 * A short-lived URL for one stored document, signed on demand.
 *
 * Not cached, unlike note images: this is one click on a row somebody chose
 * to open, not something re-requested on every render of an editor.
 */
export async function signClassDocument(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(DOCS_BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data) throw error ?? new Error("Could not open that document");
  return data.signedUrl;
}

/**
 * Delete a document; leave behind what was read out of it.
 *
 * The foreign keys are `on delete set null` for exactly this reason. By the
 * time you throw away a blurry photo of a handout you have usually corrected
 * the rows it produced by hand, and deleting the schedule along with the scan
 * would destroy the corrections rather than the scan.
 *
 * The object is best effort, like note images: a row that refuses to delete
 * because Storage was briefly unhappy costs more than an orphaned file does.
 */
export async function deleteClassDocument(
  doc: Pick<ClassDocument, "id" | "storage_path">,
): Promise<void> {
  try {
    await supabase.storage.from(DOCS_BUCKET).remove([doc.storage_path]);
  } catch {
    // Best effort, by design. See above.
  }
  const { error } = await supabase.from("class_documents").delete().eq("id", doc.id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

export async function listClassSessions(classId: string): Promise<ClassSession[]> {
  return unwrap(
    await supabase
      .from("class_sessions")
      .select("*")
      .eq("class_id", classId)
      .order("on_date"),
  );
}

/**
 * Every session across every class, for the week grid.
 *
 * Bounded by date rather than fetched whole: a term is a few hundred rows per
 * class and the grid needs a fortnight of them. Two ISO dates, because the
 * column is a `date` — comparing it against an instant would drop the far
 * edge on the day the horizon lands.
 */
export async function listSessionsBetween(
  fromDate: string,
  toDate: string,
): Promise<ClassSession[]> {
  return unwrap(
    await supabase
      .from("class_sessions")
      .select("*")
      .gte("on_date", fromDate)
      .lte("on_date", toDate)
      .order("on_date"),
  );
}

/**
 * Write the confirmed rows of one extraction.
 *
 * Replaces whatever that document produced before, and only that: sessions
 * from a different document, and any you typed in by hand, are untouched.
 * Re-extracting a corrected scan should replace its own output rather than
 * doubling the term.
 */
export async function replaceSessionsForDocument(input: {
  user_id: string;
  class_id: string;
  document_id: string;
  rows: Array<{
    on_date: string;
    topic: string;
    details: string | null;
    is_assessment: boolean;
  }>;
}): Promise<ClassSession[]> {
  const { error } = await supabase
    .from("class_sessions")
    .delete()
    .eq("document_id", input.document_id);
  if (error) throw error;

  if (!input.rows.length) return [];

  return unwrap(
    await supabase
      .from("class_sessions")
      .insert(
        input.rows.map((r) => ({
          user_id: input.user_id,
          class_id: input.class_id,
          document_id: input.document_id,
          ...r,
        })),
      )
      .select(),
  );
}

export async function updateClassSession(
  id: string,
  patch: Partial<
    Pick<ClassSession, "on_date" | "topic" | "details" | "is_assessment">
  >,
): Promise<ClassSession> {
  return unwrap(
    await supabase
      .from("class_sessions")
      .update(patch)
      .eq("id", id)
      .select()
      .single(),
  );
}

export async function deleteClassSession(id: string): Promise<void> {
  const { error } = await supabase.from("class_sessions").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Rubrics and marks
// ---------------------------------------------------------------------------

export async function listRubrics(classId: string): Promise<Rubric[]> {
  return unwrap(
    await supabase
      .from("rubrics")
      .select("*")
      .eq("class_id", classId)
      .order("created_at"),
  );
}

export async function listCriteria(rubricId: string): Promise<RubricCriterion[]> {
  return unwrap(
    await supabase
      .from("rubric_criteria")
      .select("*")
      .eq("rubric_id", rubricId)
      .order("position"),
  );
}

/**
 * Create a rubric and its components from a confirmed extraction.
 *
 * No score is written and none is accepted here. A rubric states what a
 * course is worth; what you got is typed in later, one field at a time, by
 * the person who was handed the mark.
 */
export async function createRubric(input: {
  user_id: string;
  class_id: string;
  document_id: string | null;
  title: string;
  criteria: Array<{ label: string; weight: number; max_score: number }>;
}): Promise<Rubric> {
  const rubric: Rubric = unwrap(
    await supabase
      .from("rubrics")
      .insert({
        user_id: input.user_id,
        class_id: input.class_id,
        document_id: input.document_id,
        title: input.title,
      })
      .select()
      .single(),
  );

  if (input.criteria.length) {
    const { error } = await supabase.from("rubric_criteria").insert(
      input.criteria.map((c, i) => ({
        user_id: input.user_id,
        rubric_id: rubric.id,
        label: c.label,
        weight: c.weight,
        max_score: c.max_score,
        position: i,
      })),
    );
    if (error) throw error;
  }

  return rubric;
}

export async function addCriterion(input: {
  user_id: string;
  rubric_id: string;
  label: string;
  weight: number;
  max_score: number;
  position: number;
}): Promise<RubricCriterion> {
  return unwrap(await supabase.from("rubric_criteria").insert(input).select().single());
}

/**
 * Edit one component — usually to enter a mark.
 *
 * `score: null` is a first-class value here and means ungraded: clearing the
 * box has to be able to say "not marked yet", which is a different statement
 * from zero and the one the total depends on. See `lib/grades.ts`.
 */
export async function updateCriterion(
  id: string,
  patch: Partial<Pick<RubricCriterion, "label" | "weight" | "max_score" | "score">>,
): Promise<RubricCriterion> {
  return unwrap(
    await supabase
      .from("rubric_criteria")
      .update(patch)
      .eq("id", id)
      .select()
      .single(),
  );
}

export async function deleteCriterion(id: string): Promise<void> {
  const { error } = await supabase.from("rubric_criteria").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteRubric(id: string): Promise<void> {
  const { error } = await supabase.from("rubrics").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Which calendar series is which class
// ---------------------------------------------------------------------------

/**
 * Every recurring lecture Google has told us about, one row per series.
 *
 * The mirror in `plan_blocks` holds one row per *occurrence* — a Monday
 * lecture is thirteen rows over a term — and the question a class page asks is
 * about the series: "which of these is this course". So the occurrences are
 * folded down here, keeping the earliest one as the example, because a series
 * is best identified by a name and a time you recognise.
 *
 * Dismissed occurrences count. Skipping next Tuesday's lecture is not a
 * statement about which class it belongs to, and dropping the series off this
 * list the week you decide to miss one would be the app forgetting an answer
 * because of an unrelated decision.
 */
export async function listCalendarSeries(from: Date): Promise<CalendarSeries[]> {
  const rows: PlanBlock[] = unwrap(
    await supabase
      .from("plan_blocks")
      .select("*")
      .not("google_event_id", "is", null)
      .gte("ends_at", from.toISOString())
      .order("starts_at"),
  );

  const by = new Map<string, CalendarSeries>();
  for (const r of rows) {
    // Pre-0011 rows have no series id and are their own series, exactly as
    // syncCalendar treats them.
    const id = r.google_series_id ?? r.google_event_id;
    if (!id) continue;
    const seen = by.get(id);
    if (seen) {
      seen.occurrences += 1;
      continue;
    }
    by.set(id, {
      google_series_id: id,
      title: r.title ?? "Calendar",
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      occurrences: 1,
    });
  }

  // Alphabetical, not chronological. This is a list you *search* — you know
  // the name of the course you came here to attach — and clock order would
  // scatter the same lecture's neighbours by which day of the week they fall
  // on.
  return [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export async function listClassEventLinks(): Promise<ClassEventLink[]> {
  return unwrap(await supabase.from("class_event_links").select("*"));
}

/**
 * Remember that a recurring lecture belongs to a class.
 *
 * Upserted on the series, so answering again simply changes the answer — a
 * second row would be two claims about one lecture with no rule for choosing
 * between them.
 */
export async function linkEventSeries(input: {
  user_id: string;
  google_series_id: string;
  class_id: string;
}): Promise<ClassEventLink> {
  return unwrap(
    await supabase
      .from("class_event_links")
      .upsert(input, { onConflict: "user_id,google_series_id" })
      .select()
      .single(),
  );
}

export async function unlinkEventSeries(seriesId: string): Promise<void> {
  const { error } = await supabase
    .from("class_event_links")
    .delete()
    .eq("google_series_id", seriesId);
  if (error) throw error;
}

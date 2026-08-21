import { useRef, useState } from "react";
import * as db from "../lib/db";
import { askPlanner, type PlanEdit, type PlanTurn } from "../lib/api";
import { errorText, toast } from "../lib/toast";
import { PLAN_DAYS, clockOf, formatMinutes, localIso } from "../lib/schedule";
import type { Routine, RoutineOverride, RoutineSkip, Task } from "../lib/types";

/** 0 is Sunday, matching `Date.getDay()` and the routine form's own picker. */
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * A planner you can argue with.
 *
 * Phase 07 gave the week a scheduler. What it could not take is the sentence
 * you actually have in your head on a Sunday night: *I am dead on Wednesday,
 * the essay matters more than the reading, and I am not starting anything
 * after nine.* Those are real constraints and there was no field for any of
 * them. This is the field.
 *
 * **It can do what you can do, and nothing else.** Every edit it proposes has
 * a counterpart you could perform by hand: set an estimate on a card, drag a
 * session to another hour, pull one off the board, drop an unplanned task onto
 * a day — and, since repeating blocks are a thing you can add, retime and
 * remove on this same screen, all of that too. That is the whole rule, and it
 * is what the `kind`s below amount to.
 *
 * The routine half is worth a word, because it is the one place the parity is
 * not quite symmetric. You cannot change a repeating block's *length* after
 * you have made it — the form sets it and the grid has no gesture for it — so
 * neither can the model, and it is told to say so rather than approximate it
 * by deleting and re-adding, which would lose every exception the routine
 * carries.
 *
 * The rule replaced an earlier one, and the difference is worth stating.
 * Before, the model could not touch the grid at all — it edited the planner's
 * *inputs* and let the planner produce the blocks. To make that expressive
 * enough it was given four powers of its own: split a task in two, black out
 * an afternoon, defer work to next week, set an estimate. Three of those four
 * existed nowhere else in the app. The model was the only author of that
 * state, so the only way to argue with a deferral was to ask the model to take
 * it back. A chat window had become the sole interface to a feature.
 *
 * So the powers that only it had are gone, and it was handed the ones you
 * already have instead. Now every change it makes, you can undo with a drag.
 *
 * **It proposes; you approve.** What lands is a diff against the plan you
 * already have. Accept applies exactly the rows you read — no more, and no
 * replan afterwards to move things you were not shown. Reject remembers
 * nothing and changes nothing. The chat is a way of writing a form, not a
 * thing with hands.
 *
 * **The conversation is not kept.** It lives in this component's state and
 * dies with the tab. A term of chat about which weeks went badly is a far more
 * revealing document than the task list it describes, and it is worth nothing
 * the next morning.
 */
type Line = {
  role: "user" | "model";
  text: string;
  /** Attached to a model line, and cleared the moment it is answered. */
  edits?: PlanEdit[];
  /** Set once a diff has been accepted or rejected, so it cannot be twice. */
  settled?: "accepted" | "rejected";
};

export default function PlannerChat({
  tasks,
  routines,
  routineOverrides,
  routineSkips,
  userId,
  unplaced,
  from,
  to,
  onApplied,
}: {
  tasks: Task[];
  /**
   * Repeating blocks, and the two kinds of exception carved out of them.
   *
   * All three are here for one reason: `resyncRoutine` needs the complete set
   * of overrides and skips to regenerate a routine's blocks correctly, and
   * applying two routine edits in one diff means the second must see what the
   * first wrote. Reading them back out of `store` between edits would not do —
   * that state arrives on the next render, which is one render too late for a
   * loop already running.
   */
  routines: Routine[];
  routineOverrides: RoutineOverride[];
  routineSkips: RoutineSkip[];
  userId: string;
  /** The rail, as the model should see it: what has no hour against it. */
  unplaced: { task_id: string; minutes: number }[];
  /** The horizon, as two instants. Sent in local time — see `localIso`. */
  from: Date;
  to: Date;
  /** Apply is done; reload and replan. */
  onApplied: () => Promise<void>;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [applying, setApplying] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const routineById = new Map(routines.map((r) => [r.id, r]));

  async function send() {
    const text = draft.trim();
    if (!text || asking) return;

    /*
     * Any diff still on screen is abandoned by asking again.
     *
     * It has to be. The next answer is computed against the week as it stands,
     * and a stale diff sitting above it would offer to apply edits the model
     * has since talked itself out of — two proposals on screen, both live,
     * only one of them still meant.
     */
    const history: Line[] = [
      ...lines.map((l) => (l.edits && !l.settled ? { ...l, edits: undefined } : l)),
      { role: "user" as const, text },
    ];
    setLines(history);
    setDraft("");
    setAsking(true);

    try {
      const turns: PlanTurn[] = history.map((l) => ({ role: l.role, text: l.text }));
      const advice = await askPlanner({
        turns,
        from_at: localIso(from),
        to_at: localIso(to),
        unplaced,
      });
      setLines((prev) => [
        ...prev,
        { role: "model", text: advice.message, edits: advice.edits },
      ]);
    } catch (err) {
      // Said in the conversation rather than as a toast. The question is still
      // on screen above it, and an answer that failed belongs next to the
      // question that asked it.
      setLines((prev) => [
        ...prev,
        { role: "model", text: errorText(err, "I could not answer that just now.") },
      ]);
    } finally {
      setAsking(false);
      // After the state, so the new line is the thing scrolled to.
      queueMicrotask(() => {
        const el = box.current;
        if (el) el.scrollTo({ top: el.scrollHeight });
      });
    }
  }

  /**
   * Apply the diff. Only the diff.
   *
   * There is no replan afterwards, and that is deliberate. It used to end with
   * one — the model edited the planner's inputs, so something had to run the
   * planner — which meant accepting four rows could rearrange fourteen blocks
   * you were never shown. Now every row *is* a block-level change, written
   * through the same functions a drag calls, so what lands is exactly what you
   * read. If work is left with no hour against it, the rail says so and
   * Autoplan is one press away.
   *
   * The writes are ordinary browser-to-Supabase writes under RLS — the same
   * door every other change in this app goes through.
   *
   * Sequential rather than parallel, deliberately. A partial apply is far
   * easier to understand as "it stopped there" than as "four of these seven
   * happened".
   */
  async function accept(index: number, edits: PlanEdit[]) {
    setApplying(true);

    /*
     * The routine world, carried forward across the loop.
     *
     * `resyncRoutine` regenerates a routine's blocks from the routine plus
     * every override and skip that applies to it, so each of these has to
     * reflect what the previous edit in this same diff just wrote. Props
     * cannot: they are a render behind. So the writes are mirrored here as
     * they land, and the mirror is what gets handed to the resync.
     */
    let overrides = routineOverrides;
    let skips = routineSkips;

    /** Put a routine's blocks back on the grid, as the rules now stand. */
    const resync = (routine: Routine) =>
      db.resyncRoutine(userId, routine, overrides, skips, new Date(), PLAN_DAYS);

    try {
      for (const e of edits) {
        const routine = e.routine_id ? routineById.get(e.routine_id) : undefined;

        if (e.kind === "estimate" && e.task_id && e.minutes) {
          await db.updateTask(e.task_id, { estimate_minutes: e.minutes });
        } else if (e.kind === "move_block" && e.block_id && e.starts_at && e.ends_at) {
          // The same call a drag makes, locking included. A session the model
          // put somewhere on your say-so is a session you placed.
          await db.moveBlock(e.block_id, e.starts_at, e.ends_at);
        } else if (e.kind === "unplan_block" && e.block_id) {
          await db.deleteBlock(e.block_id);
        } else if (e.kind === "place_task" && e.task_id && e.starts_at && e.ends_at) {
          await db.createTaskBlock({
            user_id: userId,
            task_id: e.task_id,
            starts_at: e.starts_at,
            ends_at: e.ends_at,
          });
        } else if (e.kind === "add_routine" && e.title && e.time_of_day && e.minutes) {
          // Created and put straight on the grid, in that order and with no
          // step in between — the same two calls the form makes, and for the
          // same reason: a repeating block that needed a second press before
          // anything appeared would be a setting pretending to be an action.
          const made = await db.createRoutine({
            user_id: userId,
            title: e.title,
            weekday: e.weekday ?? null,
            time_of_day: e.time_of_day,
            duration_minutes: e.minutes,
          });
          await db.resyncRoutine(userId, made, [], [], new Date(), PLAN_DAYS);
        } else if (e.kind === "retime_routine" && routine && e.time_of_day) {
          if (e.weekday === null || e.weekday === undefined) {
            // Every day it runs. A time restated for all of them has nothing
            // left to make an exception to, so the exceptions go with it —
            // otherwise one weekday would visibly refuse the change.
            const next = await db.updateRoutine(routine.id, {
              time_of_day: e.time_of_day,
            });
            await db.clearRoutineOverrides(routine.id);
            overrides = overrides.filter((o) => o.routine_id !== routine.id);
            await resync(next);
          } else {
            const saved = await db.setRoutineOverride({
              user_id: userId,
              routine_id: routine.id,
              weekday: e.weekday,
              time_of_day: e.time_of_day,
            });
            overrides = [
              ...overrides.filter(
                (o) => !(o.routine_id === routine.id && o.weekday === e.weekday),
              ),
              saved,
            ];
            await resync(routine);
          }
        } else if (
          e.kind === "skip_routine_weekday" &&
          routine &&
          e.weekday !== null &&
          e.weekday !== undefined
        ) {
          // The same override row as a retime, with no time on it. Null time
          // plus `skipped` is how this app has spelled "not on Thursdays"
          // since migration 0008.
          const saved = await db.setRoutineOverride({
            user_id: userId,
            routine_id: routine.id,
            weekday: e.weekday,
            time_of_day: null,
            skipped: true,
          });
          overrides = [
            ...overrides.filter(
              (o) => !(o.routine_id === routine.id && o.weekday === e.weekday),
            ),
            saved,
          ];
          await resync(routine);
        } else if (e.kind === "skip_routine_once" && routine && e.on_date) {
          // The skip is written before the blocks are rebuilt, and that order
          // is the whole of it: without the row the resync would put the
          // occurrence straight back, which reads as the app disagreeing with
          // you.
          await db.addRoutineSkip({
            user_id: userId,
            routine_id: routine.id,
            on_date: e.on_date,
          });
          skips = [
            ...skips.filter(
              (k) => !(k.routine_id === routine.id && k.on_date === e.on_date),
            ),
            {
              id: `pending:${routine.id}:${e.on_date}`,
              user_id: userId,
              routine_id: routine.id,
              on_date: e.on_date,
              created_at: new Date().toISOString(),
            },
          ];
          await resync(routine);
        } else if (e.kind === "remove_routine" && routine) {
          // The blocks go with it: plan_blocks.routine_id cascades on delete.
          await db.deleteRoutine(routine.id);
        }
      }

      setLines((prev) =>
        prev.map((l, i) => (i === index ? { ...l, settled: "accepted" } : l)),
      );
      await onApplied();
    } catch (err) {
      toast(errorText(err, "Could not apply that"), "error");
    } finally {
      setApplying(false);
    }
  }

  function reject(index: number) {
    // Nothing is written and nothing is remembered — not even that it was
    // refused. The next question starts from the week, which is unchanged.
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, settled: "rejected" } : l)),
    );
  }

  return (
    <section className="panel planner-chat">
      <div className="panel-head">
        <h2>AI assistant</h2>
      </div>

      {lines.length > 0 && (
        <div className="chat-log" ref={box}>
          {lines.map((line, i) => (
            <div key={i} className={`chat-line ${line.role}`}>
              <p className="chat-text">{line.text}</p>

              {line.edits && line.edits.length > 0 && (
                <div className={`chat-diff${line.settled ? " settled" : ""}`}>
                  <ul className="list">
                    {line.edits.map((e, j) => (
                      <li key={j} className="diff-row">
                        <span className="diff-what">
                          {describe(e, taskById, routineById)}
                        </span>
                        {e.why && <span className="muted small">{e.why}</span>}
                      </li>
                    ))}
                  </ul>

                  {line.settled ? (
                    <p className="muted small">
                      {line.settled === "accepted"
                        ? "Applied. The week is as you agreed."
                        : "Left alone. Nothing was changed."}
                    </p>
                  ) : (
                    <div className="row diff-actions">
                      <button
                        disabled={applying}
                        onClick={() => void accept(i, line.edits ?? [])}
                      >
                        {applying ? "Applying…" : "Accept"}
                      </button>
                      <button className="btn-quiet" onClick={() => reject(i)}>
                        No
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* A model line with no edits is an answer, not a failure — a
                  question back, or an honest "I cannot express that". It gets
                  no buttons, because there is nothing to agree to. */}
            </div>
          ))}
        </div>
      )}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={2}
          value={draft}
          placeholder="Describe your week…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, shift-enter breaks the line. The box is two rows
            // and almost everything typed into it is one sentence.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button disabled={asking || !draft.trim()}>
          {asking ? "Thinking…" : "Ask"}
        </button>
      </form>

    </section>
  );
}

/**
 * One edit, in a sentence a person can check before agreeing to it.
 *
 * The whole approval step depends on this reading as what will actually
 * happen. So it names the task by title rather than by id, says the minutes in
 * the form the rest of the app says them, and — for a move — names the day and
 * the clock rather than "later", because "later" is the one word somebody
 * would accept without checking.
 */
function describe(
  e: PlanEdit,
  tasks: Map<string, Task>,
  routines: Map<string, Routine>,
): string {
  const title = (e.task_id && tasks.get(e.task_id)?.title) || "that task";
  const routine = e.routine_id ? routines.get(e.routine_id) : undefined;
  const name = routine?.title || "that repeating block";

  switch (e.kind) {
    case "estimate":
      return `${title} — set to ${formatMinutes(e.minutes ?? 0)}`;
    case "move_block":
      return `${title} — moved to ${span(e.starts_at, e.ends_at)}`;
    case "unplan_block":
      // Said in full, because "remove" beside a task title reads as a delete
      // and this is the opposite: the work survives, only the hour goes.
      return `${title} — taken off the grid. The task stays, with no hour against it.`;
    case "place_task":
      return `${title} — planned for ${span(e.starts_at, e.ends_at)}`;

    /*
     * The routine rows all name the recurrence out loud.
     *
     * "Gym — 6pm" is the row somebody accepts without reading, and it is
     * missing the only part that matters: whether this is one Thursday, every
     * Thursday, or all seven days. So every one of these says which, and says
     * it in words rather than leaving a weekday number on screen.
     */
    case "add_routine":
      return (
        `New repeating block "${e.title}" — ${every(e.weekday)} at ` +
        `${at(e.time_of_day)}, for ${formatMinutes(e.minutes ?? 0)}`
      );
    case "retime_routine":
      return e.weekday === null || e.weekday === undefined
        ? `${name} — moved to ${at(e.time_of_day)}, on every day it runs`
        : `${name} — moved to ${at(e.time_of_day)} on ${WEEKDAYS[e.weekday]}s only. ` +
            `Other days keep their time.`;
    case "skip_routine_weekday":
      return (
        `${name} — no longer happens on ${WEEKDAYS[e.weekday ?? 0]}s. ` +
        `It carries on as usual the rest of the week.`
      );
    case "skip_routine_once":
      return `${name} — skipped on ${onDate(e.on_date)}. Back the week after.`;
    case "remove_routine":
      // The bluntest row in the list, and deliberately the wordiest. This one
      // deletes something that took a form to create and cannot be brought
      // back by dragging.
      return `${name} — removed for good, on every day it ran.`;

    default:
      return "A change this version does not know how to show";
  }
}

/** "every day" or "on Tuesdays" — the recurrence, as a person would say it. */
function every(weekday: number | null | undefined): string {
  return weekday === null || weekday === undefined
    ? "every day"
    : `every ${WEEKDAYS[weekday]}`;
}

/** `"18:00"` → `6 pm`, in the clock the rest of the app speaks. */
function at(hhmm: string | null | undefined): string {
  if (!hhmm) return "the same time";
  const [h, m] = hhmm.split(":").map(Number);
  return clockOf(new Date(2000, 0, 1, h || 0, m || 0));
}

/** `"2026-08-26"` → `Wednesday, 26 Aug`. Parsed local, never as UTC. */
function onDate(iso: string | null | undefined): string {
  if (!iso) return "that day";
  return new Date(`${iso}T00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

function span(starts?: string | null, ends?: string | null): string {
  if (!starts || !ends) return "some hours";
  const d = new Date(starts);
  return (
    `${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })} ` +
    `${clockOf(starts)}–${clockOf(ends)}`
  );
}

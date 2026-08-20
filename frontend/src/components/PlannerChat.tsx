import { useRef, useState } from "react";
import * as db from "../lib/db";
import { askPlanner, type PlanEdit, type PlanTurn } from "../lib/api";
import { errorText, toast } from "../lib/toast";
import { clockOf, formatMinutes, localIso } from "../lib/schedule";
import type { Task } from "../lib/types";

/**
 * A planner you can argue with.
 *
 * Phase 07 gave the week a scheduler. What it could not take is the sentence
 * you actually have in your head on a Sunday night: *I am dead on Wednesday,
 * the essay matters more than the reading, and I am not starting anything
 * after nine.* Those are real constraints and there was no field for any of
 * them. This is the field.
 *
 * **The model changes the inputs, never the output.** `planWeek` stays the
 * single scheduler — deterministic, pure, the same function the button calls.
 * What comes back from the model is a list of edits to what that function is
 * *handed*: an estimate filled in, an afternoon blacked out, a reading pushed
 * to next week, a task split in two. Accept applies those edits and reruns the
 * ordinary planner, and the ordinary planner produces every block on the grid.
 * A model emitting blocks directly would be a second scheduler with no rules,
 * indistinguishable from the first on screen and impossible to argue with when
 * it puts a session at 3am.
 *
 * **It proposes; you approve.** What lands is a diff against the plan you
 * already have. Accept applies it; reject remembers nothing and changes
 * nothing. The chat is a way of writing a form, not a thing with hands.
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
  userId,
  unplaced,
  from,
  to,
  onApplied,
}: {
  tasks: Task[];
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
   * Apply the diff, then replan.
   *
   * In that order and never the other way round: every edit here is an input
   * to `planWeek`, so a replan that ran first would be planning the week the
   * person just rejected. The writes are ordinary browser-to-Supabase writes
   * under RLS — the same door every other change in this app goes through.
   *
   * Sequential rather than parallel, deliberately. A split is two writes that
   * only make sense together, and a partial apply is far easier to understand
   * as "it stopped there" than as "four of these seven happened".
   */
  async function accept(index: number, edits: PlanEdit[]) {
    setApplying(true);
    try {
      const blackouts: {
        user_id: string;
        starts_at: string;
        ends_at: string;
        reason: string | null;
      }[] = [];

      for (const e of edits) {
        if (e.kind === "estimate" && e.task_id && e.minutes) {
          await db.updateTask(e.task_id, { estimate_minutes: e.minutes });
        } else if (e.kind === "defer" && e.task_id && e.until) {
          await db.setPlanSkip(e.task_id, e.until);
        } else if (e.kind === "split" && e.task_id && e.keep_minutes && e.rest_minutes) {
          const task = taskById.get(e.task_id);
          if (task) {
            await db.splitTask(task, e.keep_minutes, {
              title: e.rest_title ?? `${task.title} (rest)`,
              minutes: e.rest_minutes,
            });
          }
        } else if (e.kind === "blackout" && e.starts_at && e.ends_at) {
          blackouts.push({
            user_id: userId,
            starts_at: e.starts_at,
            ends_at: e.ends_at,
            reason: e.reason ?? null,
          });
        }
      }
      // One insert for the lot. They are independent rows and nothing else
      // depends on them landing one at a time.
      await db.createBlackouts(blackouts);

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
        <h2>Tell it about your week</h2>
        <span className="muted small">
          It changes what the planner is given — estimates, blocked hours, what
          can wait — and then the ordinary planner runs. Nothing happens until
          you accept it.
        </span>
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
                          {describe(e, taskById)}
                        </span>
                        {e.why && <span className="muted small">{e.why}</span>}
                      </li>
                    ))}
                  </ul>

                  {line.settled ? (
                    <p className="muted small">
                      {line.settled === "accepted"
                        ? "Applied, and the week replanned."
                        : "Left alone. Nothing was changed."}
                    </p>
                  ) : (
                    <div className="row diff-actions">
                      <button
                        disabled={applying}
                        onClick={() => void accept(i, line.edits ?? [])}
                      >
                        {applying ? "Applying…" : "Accept and replan"}
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
          placeholder="I am dead on Wednesday, the essay matters more than the reading, and I am not starting anything after nine."
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

      <p className="muted small">
        This conversation is not saved. Close the tab and it is gone; only what
        you accept is written down.
      </p>
    </section>
  );
}

/**
 * One edit, in a sentence a person can check before agreeing to it.
 *
 * The whole approval step depends on this reading as what will actually
 * happen. So it names the task by title rather than by id, says the minutes in
 * the form the rest of the app says them, and — for a deferral — says out loud
 * that the deadline has not moved, because that is the one thing somebody
 * might otherwise assume it did.
 */
function describe(e: PlanEdit, tasks: Map<string, Task>): string {
  const title = (e.task_id && tasks.get(e.task_id)?.title) || "that task";

  switch (e.kind) {
    case "estimate":
      return `${title} — set to ${formatMinutes(e.minutes ?? 0)}`;
    case "defer":
      return `${title} — no hours before ${when(e.until)}. The deadline does not move.`;
    case "split":
      return (
        `${title} — ${formatMinutes(e.keep_minutes ?? 0)} now, ` +
        `and a new task "${e.rest_title}" for the remaining ` +
        `${formatMinutes(e.rest_minutes ?? 0)}`
      );
    case "blackout":
      return `${e.reason ?? "Blocked"} — ${span(e.starts_at, e.ends_at)}`;
    default:
      return "A change this version does not know how to show";
  }
}

function when(iso: string | null | undefined): string {
  if (!iso) return "later";
  const d = new Date(`${iso}T00:00`);
  return d.toLocaleDateString(undefined, {
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

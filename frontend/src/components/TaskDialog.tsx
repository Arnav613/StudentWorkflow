import { useEffect, useRef, useState } from "react";
import * as db from "../lib/db";
import type { Class, Task, TaskStatus } from "../lib/types";
import { COLUMNS } from "../lib/board";
import { errorText, toast } from "../lib/toast";
import ChecklistEditor from "./ChecklistEditor";
import ClassPicker from "./ClassPicker";
import DatePicker from "./DatePicker";
import EstimatePicker from "./EstimatePicker";
import TimePicker from "./TimePicker";

/**
 * Editing a task that already exists.
 *
 * Everything the add form asks for, asked again in the same controls and the
 * same order — because a deadline a professor moved, a title typed in a hurry
 * and a reading that turned out to belong to a different course are all
 * ordinary Tuesday events, and until this existed the only way to fix any of
 * them was to delete the card and type it again. Which loses its checklist,
 * its estimate, and the fact that it was ever imported.
 *
 * A dialog rather than a panel inside the card, which is what the card used to
 * open. Six fields unfolding inside a column seventeen rem wide pushed
 * everything below them down the page, and the field you came to change was
 * usually the one that had just moved. The middle of the screen is the honest
 * place for a form.
 *
 * Nothing is written until Save. That is a departure from the rest of this
 * app, which commits immediately and offers Undo, and it is deliberate: a due
 * date is edited in three keystrokes that are each individually wrong, and
 * saving on every one of them would fire three writes and three toasts on the
 * way to one answer. Cancel therefore has to mean something, so Escape and the
 * backdrop both ask before throwing away real edits.
 *
 * The checklist is the exception and stays live. A checklist item is its own
 * row and has always saved itself; it is not a field of this form.
 */
export default function TaskDialog({
  task,
  classes,
  userId,
  onSaved,
  onDelete,
  onClose,
}: {
  task: Task;
  classes: Class[];
  userId: string;
  /** The saved row, so the board can drop it in without a full refresh. */
  onSaved: (task: Task) => void;
  /** Deleting is the board's, so it keeps its undo. Closes the dialog first. */
  onDelete: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [date, setDate] = useState(() => datePart(task.due_at));
  const [time, setTime] = useState(() => timePart(task.due_at));
  const [classId, setClassId] = useState(task.class_id ?? "");
  const [estimate, setEstimate] = useState<number | null>(task.estimate_minutes);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const dirty =
    title.trim() !== task.title ||
    description.trim() !== (task.description ?? "") ||
    dueAtFrom(date, time) !== task.due_at ||
    (classId || null) !== task.class_id ||
    estimate !== task.estimate_minutes ||
    status !== task.status;

  /**
   * Escape closes, and is caught in the capture phase.
   *
   * The board underneath answers Escape by clearing the selection, and a key
   * that both closes this and empties the selection behind it is one key doing
   * two things — the second of which you cannot see happening.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  function close() {
    // Only asks when there is something to lose. A dialog opened to read a
    // description and closed again must not interrogate you about it.
    if (dirty && !confirm("Close without saving your changes?")) return;
    onClose();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const next = title.trim();
    if (!next) return;
    if (!dirty) return onClose();

    setBusy(true);
    try {
      const saved = await db.updateTask(task.id, {
        title: next,
        description: description.trim() || null,
        due_at: dueAtFrom(date, time),
        class_id: classId || null,
        estimate_minutes: estimate,
        status,
        // The same rule the board follows on a drag: pulling a card out of
        // Done that sync put there is a disagreement with sync, and sync
        // should stop putting it back. See db.moveTask.
        ...(task.auto_completed && status !== "done"
          ? { status_overridden: true }
          : {}),
      });
      onSaved(saved);
      onClose();
    } catch (err) {
      toast(errorText(err, "Could not save that"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="scrim"
      role="presentation"
      // Only a press that both starts and ends on the backdrop counts — a
      // drag that began on a field and released outside it is a slip.
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      // The board below is a drag surface and a selection surface. Nothing
      // that happens inside this dialog is either.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <form
        className="dialog task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${task.title}`}
        onSubmit={save}
      >
        <div className="task-dialog-head">
          <input
            ref={field}
            className="task-dialog-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            aria-label="Title"
            required
          />
          {task.source === "classroom" && <span className="tag">Classroom</span>}
        </div>

        <label className="field">
          <span className="label">Notes</span>
          <input
            value={description}
            placeholder="Anything worth remembering"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {/* Divs, not labels, around the pickers: those controls are buttons,
            and a label wrapping one hijacks its click. Same as the add form. */}
        <div className="task-dialog-row">
          <div className="field">
            <span className="label">Due</span>
            <DatePicker
              value={date}
              onChange={(next) => {
                setDate(next);
                // Clearing the date clears the time with it: the time control
                // is disabled without one, so a leftover value would be
                // unreachable and would reappear on the next date chosen.
                if (!next) setTime("");
              }}
            />
          </div>
          <div className="field">
            <span className="label">Time</span>
            <TimePicker value={time} disabled={!date} onChange={setTime} />
          </div>
        </div>

        <div className="task-dialog-row">
          <div className="field">
            <span className="label">Class</span>
            <ClassPicker
              classes={classes.filter((c) => !c.hidden || c.id === task.class_id)}
              value={classId}
              onChange={setClassId}
            />
          </div>
          <div className="field">
            <span className="label">Takes about</span>
            <EstimatePicker value={estimate} onChange={setEstimate} />
          </div>
        </div>

        {/* Dragging is the primary way a card changes column. This is how the
            board stays usable with a keyboard, and on a phone where a drag
            across three columns is genuinely awkward. */}
        <label className="field">
          <span className="label">Column</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          >
            {COLUMNS.map((c) => (
              <option key={c.status} value={c.status}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <ChecklistEditor taskId={task.id} userId={userId} />

        <div className="task-dialog-actions">
          <button
            type="button"
            className="link danger"
            onClick={() => {
              onClose();
              onDelete();
            }}
          >
            Delete task
          </button>
          <span className="grow" />
          <button type="button" className="link" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * An instant, split back into the day and the clock it was typed as.
 *
 * Local, not UTC: the stored value is an instant, but what the person wrote
 * was a wall clock in their own zone, and the whole point of opening this
 * dialog is to see what they wrote. `toISOString().slice(0, 10)` would be the
 * one-liner and it is wrong by a day for anything due in the evening east of
 * Greenwich — which is every evening deadline this app was built for.
 */
function datePart(due: string | null): string {
  if (!due) return "";
  const d = new Date(due);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The clock, or "" for midnight.
 *
 * Midnight is how a whole-day deadline is stored — due by the end of that day
 * — and the add form writes it by leaving the time blank. Reading it back as
 * "12:00 AM" would give every whole-day task an invented hour the first time
 * anybody opened it to fix a typo in the title.
 */
function timePart(due: string | null): string {
  if (!due) return "";
  const d = new Date(due);
  if (!d.getHours() && !d.getMinutes()) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The inverse. Kept identical to the add form's, deliberately. */
function dueAtFrom(date: string, time: string): string | null {
  if (!date) return null;
  return new Date(`${date}T${time || "00:00"}`).toISOString();
}

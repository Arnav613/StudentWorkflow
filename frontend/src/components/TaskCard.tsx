import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import * as db from "../lib/db";
import type { Class, Task, TaskStatus } from "../lib/types";
import {
  COLUMNS,
  daysUntilArchive,
  formatDue,
  formatDueExact,
  formatLate,
  isOverdue,
} from "../lib/board";
import { toast, undoable } from "../lib/toast";
import ChecklistEditor from "./ChecklistEditor";

/**
 * One card on the board.
 *
 * The whole card is the drag handle rather than a grip in the corner — the
 * gesture people expect from a board is picking the card up. That would
 * normally swallow the buttons inside it, so the sensor in TaskBoard only
 * starts a drag after a few pixels of movement; a click stays a click.
 */
export default function TaskCard({
  task,
  cls,
  userId,
  onMove,
  onChanged,
  onRemove,
  onOpenClass,
}: {
  task: Task;
  cls: Class | null;
  userId: string;
  onMove: (task: Task, status: TaskStatus) => void;
  onChanged: () => void;
  onRemove?: (task: Task) => void;
  /** Set on the all-classes board, absent inside a class — where it would
      only ever navigate to the page you are already on. */
  onOpenClass?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const overdue = isOverdue(task);
  const archiveIn = daysUntilArchive(task);

  async function remove() {
    if (onRemove) return onRemove(task);
    // Fallback for any caller that has not wired the optimistic path: still
    // no confirm() box, still undoable, just without the list update.
    undoable({
      message: `Deleted "${task.title}"`,
      apply: () => setOpen(false),
      commit: async () => {
        await db.deleteTask(task.id);
        onChanged();
      },
      revert: () => onChanged(),
      onError: () => toast("The task is still there", "info"),
    });
  }

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`card ${cls ? `hue-${cls.color}` : "hue-none"} ${
        isDragging ? "dragging" : ""
      } ${overdue ? "overdue" : ""}`}
    >
      <div className="row">
        <span
          className={`grow card-title ${task.status === "done" ? "struck" : ""}`}
        >
          {task.title}
        </span>
        <button
          className="link"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "Close" : "Open"}
        </button>
      </div>

      <div className="row card-meta">
        <span
          className={overdue ? "error" : "muted"}
          title={formatDueExact(task.due_at)}
        >
          {overdue ? formatLate(task.due_at) : formatDue(task.due_at)}
        </span>

        {cls &&
          (onOpenClass ? (
            <button
              className="tag tag-hue tag-button"
              onClick={() => onOpenClass(cls.id)}
              title={`Open ${cls.name}`}
            >
              <span className="dot" />
              {cls.name}
            </button>
          ) : (
            <span className="tag tag-hue">
              <span className="dot" />
              {cls.name}
            </span>
          ))}

        {task.source === "classroom" && <span className="tag">Classroom</span>}

        {/* The promise phase 04 has to keep: a card that moved itself says so,
            and stops saying so the moment you move it back by hand. */}
        {task.auto_completed && !task.status_overridden && (
          <span className="tag">Marked automatically</span>
        )}

        {archiveIn !== null && (
          <span className="muted">
            {archiveIn === 0 ? "Archives today" : `Archives in ${archiveIn}d`}
          </span>
        )}
      </div>

      {open && (
        <div className="task-detail">
          {task.description && <p className="small">{task.description}</p>}

          {/* Dragging is the primary gesture; this is how the board stays
              usable with a keyboard, and on a phone where a long drag across
              three columns is genuinely awkward. */}
          <label className="label">
            Column
            <select
              value={task.status}
              onChange={(e) => onMove(task, e.target.value as TaskStatus)}
            >
              {COLUMNS.map((c) => (
                <option key={c.status} value={c.status}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <ChecklistEditor taskId={task.id} userId={userId} />

          <div className="row end">
            <button className="link danger" onClick={remove}>
              Delete task
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

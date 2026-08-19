import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import * as db from "../lib/db";
import type { Class, Task, TaskStatus } from "../lib/types";
import { COLUMNS, daysUntilArchive, formatDue, isOverdue } from "../lib/board";
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
}: {
  task: Task;
  cls: Class | null;
  userId: string;
  onMove: (task: Task, status: TaskStatus) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const overdue = isOverdue(task);
  const archiveIn = daysUntilArchive(task);

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`card ${isDragging ? "dragging" : ""} ${overdue ? "overdue" : ""}`}
    >
      <div className="row">
        <span className={`grow ${task.status === "done" ? "struck" : ""}`}>
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

      <div className="row small">
        <span className={overdue ? "error" : "muted"}>
          {overdue ? "Overdue · " : ""}
          {formatDue(task.due_at)}
        </span>

        {cls && (
          <span className="tag">
            <span className={`dot dot-${cls.color}`} />
            {cls.name}
          </span>
        )}

        {task.source === "classroom" && <span className="tag dim">Classroom</span>}

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

          <button
            className="link danger"
            onClick={async () => {
              await db.deleteTask(task.id);
              onChanged();
            }}
          >
            Delete task
          </button>
        </div>
      )}
    </li>
  );
}

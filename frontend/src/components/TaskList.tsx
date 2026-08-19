import { useState } from "react";
import * as db from "../lib/db";
import type { Class, Task, TaskStatus } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import ChecklistEditor from "./ChecklistEditor";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Do",
  doing: "Doing",
  done: "Done",
};

function formatDue(due: string | null): { text: string; overdue: boolean } {
  if (!due) return { text: "No due date", overdue: false };
  const d = new Date(due);
  const overdue = d.getTime() < Date.now();
  return {
    text: d.toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }),
    overdue,
  };
}

/**
 * A flat list for phase 01 — the point here is getting real deadlines typed
 * in and visible. Phase 02 replaces this with the draggable Do/Doing/Done
 * board; the status control below is the stopgap that makes tasks movable
 * before drag-and-drop exists.
 */
export default function TaskList({ store }: { store: DataStore }) {
  const { tasks, classes, refresh, userId } = store;
  const [expanded, setExpanded] = useState<string | null>(null);

  const classById = new Map<string, Class>(classes.map((c) => [c.id, c]));

  async function setStatus(task: Task, status: TaskStatus) {
    await db.moveTask(task.id, status);
    await refresh();
  }

  async function remove(task: Task) {
    await db.deleteTask(task.id);
    await refresh();
  }

  if (tasks.length === 0) {
    return (
      <section className="panel">
        <h2>Tasks</h2>
        <p className="muted">
          Nothing yet. Add your deadlines above — coursework, club meetings,
          laundry.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Tasks ({tasks.length})</h2>
      <ul className="list tasks">
        {tasks.map((task) => {
          const due = formatDue(task.due_at);
          const cls = task.class_id ? classById.get(task.class_id) : null;
          const isOpen = expanded === task.id;

          return (
            <li key={task.id} className="task">
              <div className="row">
                <span className={`grow ${task.status === "done" ? "struck" : ""}`}>
                  {task.title}
                </span>

                {cls && (
                  <span className="tag">
                    <span className={`dot dot-${cls.color}`} />
                    {cls.name}
                  </span>
                )}

                <span className={due.overdue && task.status !== "done" ? "error small" : "muted small"}>
                  {due.text}
                </span>

                <select
                  value={task.status}
                  onChange={(e) => setStatus(task, e.target.value as TaskStatus)}
                >
                  {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>

                <button className="link" onClick={() => setExpanded(isOpen ? null : task.id)}>
                  {isOpen ? "Close" : "Open"}
                </button>
              </div>

              {isOpen && (
                <div className="task-detail">
                  {task.description && <p>{task.description}</p>}
                  <ChecklistEditor taskId={task.id} userId={userId} />
                  <button className="link danger" onClick={() => remove(task)}>
                    Delete task
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

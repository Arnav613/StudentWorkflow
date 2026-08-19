import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import * as db from "../lib/db";
import type { Class, Task, TaskStatus } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import { COLUMNS, groupByColumn } from "../lib/board";
import { toast, undoable } from "../lib/toast";
import BoardColumn from "./BoardColumn";
import TaskCard from "./TaskCard";

const EMPTY: Record<TaskStatus, string> = {
  todo: "Nothing waiting.",
  doing: "Drag something here when you start it.",
  done: "Finished work lands here for a week.",
};

/**
 * Phase 03. Every live task, three columns, drag between them.
 *
 * Replaces the flat list from phase 01. The list was the right thing while the
 * question was "do real deadlines arrive"; the board is the right thing now
 * that they do, because the question became "what do I do next".
 */
export default function TaskBoard({
  store,
  emptyFor,
  onOpenClass,
}: {
  store: DataStore;
  /** Named when the board is showing one class, so the empty state can say so. */
  emptyFor?: string;
  onOpenClass?: (id: string) => void;
}) {
  const { tasks, classes, refresh, moveTask, setTasks, userId } = store;
  const [dragging, setDragging] = useState<Task | null>(null);

  // Distance, not delay: a drag must not start on a click aimed at the Open
  // button, and must not cost a held pause when it is a real drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const classById = useMemo(
    () => new Map<string, Class>(classes.map((c) => [c.id, c])),
    [classes],
  );

  // Recomputed per render rather than memoised on `tasks`: overdue depends on
  // the clock, not only on the data, and a card that stays un-pinned because
  // nothing in the array changed is the bug worth avoiding here.
  const columns = groupByColumn(tasks);

  function onDragStart(e: DragStartEvent) {
    setDragging(tasks.find((t) => t.id === e.active.id) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const status = e.over?.id as TaskStatus | undefined;
    if (!status) return; // dropped outside every column: no-op, not a delete
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task || task.status === status) return;
    void moveTask(task, status, positionFor(columns[status]));
  }

  /**
   * Deleting a card. Optimistic with a five-second hold, not a confirm() box
   * — see lib/toast. The row leaves the column immediately, which is the
   * feedback that matters, and the database write is what waits.
   */
  function remove(task: Task) {
    const previous = tasks;
    undoable({
      message: `Deleted "${task.title}"`,
      apply: () => setTasks((prev) => prev.filter((t) => t.id !== task.id)),
      commit: () => db.deleteTask(task.id),
      revert: () => setTasks(previous),
      onError: () => toast("The task is still there", "info"),
    });
  }

  if (tasks.length === 0) {
    return (
      <section className="panel empty-state">
        <p className="empty-title">
          {emptyFor ? `Nothing for ${emptyFor} yet` : "Nothing on the board"}
        </p>
        <p className="muted">
          {emptyFor
            ? "Deadlines you add on the To do tab, and anything Classroom imports for this course, will show up here."
            : "Add your deadlines above — coursework, club meetings, laundry."}
        </p>
      </section>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="board">
        {COLUMNS.map(({ status, label }) => (
          <BoardColumn
            key={status}
            status={status}
            label={label}
            count={columns[status].length}
            empty={EMPTY[status]}
          >
            {columns[status].map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                cls={task.class_id ? classById.get(task.class_id) ?? null : null}
                userId={userId}
                onMove={(t, s) => void moveTask(t, s, positionFor(columns[s]))}
                onChanged={refresh}
                onRemove={remove}
                onOpenClass={onOpenClass}
              />
            ))}
          </BoardColumn>
        ))}
      </div>

      {/* The card follows the cursor instead of the original leaving a hole
          — the hole is what makes a board feel like it lost your task. */}
      <DragOverlay>
        {dragging && <div className="card overlay">{dragging.title}</div>}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Where an arriving card sits among the *undated* tasks of its new column.
 *
 * Last, and only among those: everything with a due date is ordered by that
 * date regardless. Gaps are fine — position is a sort key, not an index.
 */
function positionFor(column: Task[]): number {
  return column.reduce((max, t) => Math.max(max, t.position), 0) + 1;
}

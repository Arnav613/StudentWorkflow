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
import { errorText, toast, undoable } from "../lib/toast";
import { useSelection } from "../hooks/useSelection";
import BoardColumn from "./BoardColumn";
import TaskCard from "./TaskCard";
import SelectionBar from "./SelectionBar";
import EstimatePicker from "./EstimatePicker";
import ClassPicker from "./ClassPicker";

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
 *
 * Several cards can be selected at once with ctrl and shift, and then moved,
 * re-estimated, reassigned or deleted together. That is not a power-user
 * flourish: the week a term actually breaks is the week eleven readings arrive
 * from one course, and doing anything to eleven cards one at a time is how a
 * board stops being opened.
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

  /*
   * The order a shift-range runs along: the order the eye reads the board in.
   *
   * Left to right, then down each column — so shift-clicking from the top of
   * To do to the middle of Doing takes everything in between, across the
   * column boundary. Keeping ranges inside one column was the other option and
   * it is the wrong one here: the columns are three states of one list, not
   * three lists, and "everything from here to there" is a sentence about the
   * board.
   */
  const order = useMemo(
    () => COLUMNS.flatMap(({ status }) => columns[status].map((t) => t.id)),
    // `columns` is rebuilt every render; its contents come from tasks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks],
  );
  const selection = useSelection(order);

  const taskById = useMemo(
    () => new Map(tasks.map((t) => [t.id, t])),
    [tasks],
  );
  const chosen = useMemo(
    () =>
      [...selection.selected]
        .map((id) => taskById.get(id))
        .filter((t): t is Task => Boolean(t)),
    [selection.selected, taskById],
  );

  function onDragStart(e: DragStartEvent) {
    setDragging(tasks.find((t) => t.id === e.active.id) ?? null);
  }

  /**
   * Dropping into a column.
   *
   * A card that is part of the selection brings the selection with it — which
   * is the only reading of dragging one of four highlighted cards that is not
   * a surprise. A card outside the selection is just itself, and leaves the
   * selection alone rather than silently clearing it.
   */
  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const status = e.over?.id as TaskStatus | undefined;
    if (!status) return; // dropped outside every column: no-op, not a delete
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task) return;

    if (selection.count > 1 && selection.has(task.id)) {
      void moveMany(chosen, status);
      return;
    }
    if (task.status === status) return;
    void moveTask(task, status, positionFor(columns[status]));
  }

  /* --- Everything that acts on more than one card -------------------------- */

  /**
   * Optimistic, like the single-card path, and for the same reason: the whole
   * value of selecting eight things is not doing eight things one at a time,
   * which includes not watching eight round trips.
   */
  async function moveMany(list: Task[], status: TaskStatus) {
    const moving = list.filter((t) => t.status !== status);
    if (!moving.length) return;
    const ids = new Set(moving.map((t) => t.id));
    const previous = tasks;

    setTasks((prev) => prev.map((t) => (ids.has(t.id) ? { ...t, status } : t)));
    try {
      const saved = await db.moveTasks(moving, status);
      const byId = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
    } catch (e) {
      setTasks(previous);
      toast(errorText(e, "Could not move those"), "error");
    }
  }

  async function patchMany(
    patch: Partial<Pick<Task, "class_id" | "estimate_minutes">>,
    said: string,
  ) {
    if (!chosen.length) return;
    const ids = chosen.map((t) => t.id);
    const previous = tasks;
    const idSet = new Set(ids);

    setTasks((prev) => prev.map((t) => (idSet.has(t.id) ? { ...t, ...patch } : t)));
    try {
      const saved = await db.updateTasks(ids, patch);
      const byId = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
      toast(said, "success");
    } catch (e) {
      setTasks(previous);
      toast(errorText(e, "Could not change those"), "error");
    }
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

  /**
   * The same, for a selection.
   *
   * Still no confirm box, and the five seconds matter more here than anywhere
   * else in the app: this is the one gesture that can take eleven things away
   * at once, and Undo is a better answer than a dialog because it costs
   * nothing when you meant it.
   */
  function removeMany() {
    if (!chosen.length) return;
    const ids = chosen.map((t) => t.id);
    const idSet = new Set(ids);
    const previous = tasks;
    const n = ids.length;

    selection.clear();
    undoable({
      message: `Deleted ${n} tasks`,
      apply: () => setTasks((prev) => prev.filter((t) => !idSet.has(t.id))),
      commit: () => db.deleteTasks(ids),
      revert: () => setTasks(previous),
      onError: () => toast("They are still there", "info"),
    });
  }

  if (tasks.length === 0) {
    return (
      <section className="panel empty-state">
        <p className="empty-title">
          {emptyFor ? `Nothing for ${emptyFor} yet` : "Nothing on the board"}
        </p>
      </section>
    );
  }

  /** One class across the selection, or "" when they disagree. */
  const sharedClass =
    chosen.length && chosen.every((t) => t.class_id === chosen[0].class_id)
      ? chosen[0].class_id ?? ""
      : "";
  const sharedEstimate =
    chosen.length &&
    chosen.every((t) => t.estimate_minutes === chosen[0].estimate_minutes)
      ? chosen[0].estimate_minutes
      : null;

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
                selected={selection.has(task.id)}
                onSelect={(e) => selection.select(task.id, e)}
              />
            ))}
          </BoardColumn>
        ))}
      </div>

      {/* The card follows the cursor instead of the original leaving a hole
          — the hole is what makes a board feel like it lost your task.
          Dragging one of several says how many are coming with it, since the
          other three are somewhere behind the cursor and easy to forget. */}
      <DragOverlay>
        {dragging && (
          <div className="card overlay">
            {selection.count > 1 && selection.has(dragging.id)
              ? `${selection.count} tasks`
              : dragging.title}
          </div>
        )}
      </DragOverlay>

      <SelectionBar count={selection.count} onClear={selection.clear}>
        {COLUMNS.map(({ status, label }) => (
          <button
            key={status}
            className="btn-quiet"
            onClick={() => void moveMany(chosen, status)}
          >
            {label}
          </button>
        ))}

        <span className="selection-sep" aria-hidden="true" />

        <EstimatePicker
          value={sharedEstimate}
          onChange={(m) =>
            void patchMany(
              { estimate_minutes: m },
              m === null ? "Estimates cleared" : "Estimate applied",
            )
          }
        />
        <ClassPicker
          classes={classes}
          value={sharedClass}
          onChange={(id) =>
            void patchMany(
              { class_id: id || null },
              id ? "Moved to that class" : "Class cleared",
            )
          }
        />

        <button className="btn-quiet danger" onClick={removeMany}>
          Delete
        </button>
      </SelectionBar>
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

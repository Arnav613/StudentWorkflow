import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import * as db from "../lib/db";
import type { Class, Task, TaskGroup, TaskStatus } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import { COLUMNS, byClass, cluster, groupByColumn, type BoardRow } from "../lib/board";
import { errorText, toast, undoable } from "../lib/toast";
import { useSelection, type Selection } from "../hooks/useSelection";
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

/** How the same cards are arranged. The toggle lives on the To do page. */
export type BoardMode = "columns" | "class";

/**
 * Phase 03. Every live task, three columns, drag between them.
 *
 * Replaces the flat list from phase 01. The list was the right thing while the
 * question was "do real deadlines arrive"; the board is the right thing now
 * that they do, because the question became "what do I do next".
 *
 * Several cards can be selected at once with ctrl and shift, and then moved,
 * re-estimated, reassigned, grouped or deleted together. That is not a
 * power-user flourish: the week a term actually breaks is the week eleven
 * readings arrive from one course, and doing anything to eleven cards one at a
 * time is how a board stops being opened.
 *
 * Two arrangements, one board. `columns` is the three states of the work;
 * `class` is the same cards filed by course. The toggle is on the page above,
 * because it is a fact about how you are reading today and not about the data
 * — and crucially neither arrangement, and no group made in either, touches a
 * due date, an estimate or an hour. The Week cannot tell which one is up.
 */
export default function TaskBoard({
  store,
  emptyFor,
  onOpenClass,
  mode = "columns",
}: {
  store: DataStore;
  /** Named when the board is showing one class, so the empty state can say so. */
  emptyFor?: string;
  onOpenClass?: (id: string) => void;
  mode?: BoardMode;
}) {
  const { tasks, classes, groups, refresh, moveTask, setTasks, setGroups, userId } =
    store;
  const [dragging, setDragging] = useState<Task | null>(null);
  /** Groups the reader has folded shut. Ids, so a rename cannot lose one. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  /** Done sections opened in the by-class view — the same idea, inverted. */
  const [showDone, setShowDone] = useState<ReadonlySet<string>>(() => new Set());
  /** Non-null while the selection bar is asking what to call a new group. */
  const [naming, setNaming] = useState<string | null>(null);

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
  const groupById = useMemo(
    () => new Map<string, TaskGroup>(groups.map((g) => [g.id, g])),
    [groups],
  );

  // Recomputed per render rather than memoised on `tasks`: overdue depends on
  // the clock, not only on the data, and a card that stays un-pinned because
  // nothing in the array changed is the bug worth avoiding here.
  const columns = groupByColumn(tasks);
  const sections = byClass(tasks, classes);

  /** What each arrangement draws, with groups clustered in place. */
  const columnRows = useMemo(
    () =>
      Object.fromEntries(
        COLUMNS.map(({ status }) => [status, cluster(columns[status], groupById)]),
      ) as Record<TaskStatus, BoardRow[]>,
    // `columns` is rebuilt every render; its contents come from tasks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, groupById],
  );
  const sectionRows = useMemo(
    () =>
      sections.map((s) => ({
        ...s,
        rows: cluster(s.live, groupById),
        doneRows: cluster(s.done, groupById),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, classes, groupById],
  );

  /*
   * The order a shift-range runs along: the order the eye reads the board in.
   *
   * Left to right, then down each column — so shift-clicking from the top of
   * To do to the middle of Doing takes everything in between, across the
   * column boundary. Keeping ranges inside one column was the other option and
   * it is the wrong one here: the columns are three states of one list, not
   * three lists, and "everything from here to there" is a sentence about the
   * board.
   *
   * A card inside a folded group, or behind an unopened Done line, is not in
   * this list. It is not on screen, and a selection that reaches something the
   * person cannot see is one bulk Delete away from being the worst bug in the
   * app — see the note in useSelection about stranded ids.
   */
  const order = useMemo(() => {
    const ids: string[] = [];
    const walk = (rows: BoardRow[]) => {
      for (const row of rows) {
        if (row.kind === "task") ids.push(row.task.id);
        else if (!folded.has(row.group.id)) {
          for (const t of row.tasks) ids.push(t.id);
        }
      }
    };
    if (mode === "columns") {
      for (const { status } of COLUMNS) walk(columnRows[status]);
    } else {
      for (const s of sectionRows) {
        walk(s.rows);
        if (showDone.has(sectionKey(s.cls))) walk(s.doneRows);
      }
    }
    return ids;
  }, [mode, columnRows, sectionRows, folded, showDone]);

  const selection = useSelection(order);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
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
   * Dropping.
   *
   * What a drop *means* is the one thing the two arrangements disagree about,
   * and they disagree honestly: columns are statuses, so landing in one is a
   * change of status; sections are classes, so landing in one is a change of
   * class. Either way it is the thing the reader is looking at, which is the
   * only rule a drag has to follow.
   *
   * A card that is part of the selection brings the selection with it — which
   * is the only reading of dragging one of four highlighted cards that is not
   * a surprise. A card outside the selection is just itself, and leaves the
   * selection alone rather than silently clearing it.
   */
  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const over = e.over?.id;
    if (!over) return; // dropped outside everything: no-op, not a delete
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task) return;
    const many = selection.count > 1 && selection.has(task.id);

    if (typeof over === "string" && over.startsWith("class:")) {
      const id = over.slice(6);
      const classId = id === "none" ? null : id;
      const moving = (many ? chosen : [task]).filter((t) => t.class_id !== classId);
      if (!moving.length) return;
      void patch(
        moving.map((t) => t.id),
        { class_id: classId },
        classId
          ? `Moved to ${classById.get(classId)?.name ?? "that class"}`
          : "Class cleared",
      );
      return;
    }

    const status = over as TaskStatus;
    if (many) {
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

  /** One patch across a named set of ids, optimistically. */
  async function patch(
    ids: string[],
    fields: Partial<Pick<Task, "class_id" | "estimate_minutes" | "group_id">>,
    said: string,
  ) {
    if (!ids.length) return;
    const previous = tasks;
    const idSet = new Set(ids);

    setTasks((prev) => prev.map((t) => (idSet.has(t.id) ? { ...t, ...fields } : t)));
    try {
      const saved = await db.updateTasks(ids, fields);
      const byId = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
      toast(said, "success");
    } catch (e) {
      setTasks(previous);
      toast(errorText(e, "Could not change those"), "error");
    }
  }

  function patchMany(
    fields: Partial<Pick<Task, "class_id" | "estimate_minutes">>,
    said: string,
  ) {
    return patch(
      chosen.map((t) => t.id),
      fields,
      said,
    );
  }

  /* --- Groups -------------------------------------------------------------- */

  /**
   * File the selection under a new name.
   *
   * The name is asked for rather than invented. A group called "Group 2" is a
   * row you have to open to find out what is in it, which is the opposite of
   * the point — and the moment you are naming it is the moment you know what
   * it is, which is never true again afterwards.
   *
   * Nothing else about the cards changes. No due date is copied up, no
   * estimate is summed, no block is touched: the Week is drawn from the same
   * rows it was drawn from a second ago, which is exactly the promise made
   * when this was asked for.
   */
  async function group(title: string) {
    const list = chosen;
    if (!list.length) return;
    const ids = list.map((t) => t.id);
    const idSet = new Set(ids);
    const previousTasks = tasks;
    const previousGroups = groups;

    setNaming(null);
    try {
      const made = await db.createGroup({
        user_id: userId,
        title: title.trim(),
        position: groups.reduce((max, g) => Math.max(max, g.position), 0) + 1,
      });
      setGroups((prev) => [...prev, made]);
      setTasks((prev) =>
        prev.map((t) => (idSet.has(t.id) ? { ...t, group_id: made.id } : t)),
      );
      const saved = await db.setTaskGroup(ids, made.id);
      const byId = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
      selection.clear();
      toast(`${ids.length} filed under "${made.title}"`, "success");
    } catch (e) {
      setTasks(previousTasks);
      setGroups(previousGroups);
      toast(errorText(e, "Could not group those"), "error");
    }
  }

  /**
   * Take the label off. The cards stay exactly where they are.
   *
   * This is also what Delete would mean on a group, and there is deliberately
   * only one verb for it: a label lifted off eleven readings must never be a
   * way to delete eleven readings, and a menu offering both would eventually
   * be misread by someone in the week they could least afford it.
   */
  async function ungroup(g: TaskGroup) {
    const previousTasks = tasks;
    const previousGroups = groups;
    setGroups((prev) => prev.filter((x) => x.id !== g.id));
    setTasks((prev) =>
      prev.map((t) => (t.group_id === g.id ? { ...t, group_id: null } : t)),
    );
    try {
      // The tasks are freed by the delete itself — group_id is `on delete set
      // null` — so there is no second write here to leave half done.
      await db.deleteGroup(g.id);
      toast(`"${g.title}" ungrouped`, "success");
    } catch (e) {
      setTasks(previousTasks);
      setGroups(previousGroups);
      toast(errorText(e, "Could not ungroup that"), "error");
    }
  }

  async function rename(g: TaskGroup, title: string) {
    const next = title.trim();
    if (!next || next === g.title) return;
    const previous = groups;
    setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, title: next } : x)));
    try {
      await db.renameGroup(g.id, next);
    } catch (e) {
      setGroups(previous);
      toast(errorText(e, "Could not rename that"), "error");
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
  /** Every selected card already under one and the same group, or null. */
  const sharedGroup =
    chosen.length &&
    chosen.every((t) => t.group_id && t.group_id === chosen[0].group_id)
      ? groupById.get(chosen[0].group_id!) ?? null
      : null;

  /** One card, wherever it is being drawn. */
  function card(task: Task) {
    return (
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
    );
  }

  function rows(list: BoardRow[]) {
    return list.map((row) =>
      row.kind === "task" ? (
        card(row.task)
      ) : (
        <GroupRow
          key={row.group.id}
          group={row.group}
          tasks={row.tasks}
          folded={folded.has(row.group.id)}
          onFold={() =>
            setFolded((prev) => {
              const next = new Set(prev);
              if (!next.delete(row.group.id)) next.add(row.group.id);
              return next;
            })
          }
          onRename={(title) => void rename(row.group, title)}
          onUngroup={() => void ungroup(row.group)}
          selection={selection}
        >
          {row.tasks.map(card)}
        </GroupRow>
      ),
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {mode === "columns" ? (
        <div className="board">
          {COLUMNS.map(({ status, label }) => (
            <BoardColumn
              key={status}
              status={status}
              label={label}
              count={columns[status].length}
              empty={EMPTY[status]}
            >
              {rows(columnRows[status])}
            </BoardColumn>
          ))}
        </div>
      ) : (
        <div className="by-class">
          {sectionRows.map((s) => {
            const key = sectionKey(s.cls);
            const open = showDone.has(key);
            return (
              <ClassSection
                key={key}
                cls={s.cls}
                count={s.live.length}
                done={s.done.length}
                doneOpen={open}
                onToggleDone={() =>
                  setShowDone((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(key)) next.add(key);
                    return next;
                  })
                }
                onOpenClass={onOpenClass}
                finished={open ? rows(s.doneRows) : null}
              >
                {rows(s.rows)}
              </ClassSection>
            );
          })}
        </div>
      )}

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
        {/*
          The bar becomes a single question while a group is being named, and
          gives itself back the moment it is answered. A dialog over a board
          you are still reading is the wrong shape for a control whose only
          input is six characters — and the cards being named are exactly the
          ones a dialog would have covered.
        */}
        {naming === null ? (
          <>
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

            {sharedGroup ? (
              <button
                className="btn-quiet"
                onClick={() => void ungroup(sharedGroup)}
                title={`Take the "${sharedGroup.title}" label off`}
              >
                Ungroup
              </button>
            ) : (
              <button className="btn-quiet" onClick={() => setNaming("")}>
                Group
              </button>
            )}

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
          </>
        ) : (
          <form
            className="row group-name"
            onSubmit={(e) => {
              e.preventDefault();
              if (naming.trim()) void group(naming);
            }}
          >
            <input
              autoFocus
              placeholder="Call it what it is"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                // Escape backs out of naming without emptying the selection,
                // which is otherwise what Escape does on this screen.
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNaming(null);
                }
              }}
            />
            <button className="btn-quiet" disabled={!naming.trim()}>
              Group {chosen.length}
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setNaming(null)}
            >
              Cancel
            </button>
          </form>
        )}
      </SelectionBar>
    </DndContext>
  );
}

/* -------------------------------------------------------------------------- */

/** Sections are keyed by class id, plus one reserved word for the loose one. */
function sectionKey(cls: Class | null): string {
  return cls ? cls.id : "none";
}

/**
 * A group, drawn as a header with its cards under it.
 *
 * Folded, it is one line saying a name and a number. That is the entire
 * feature: a course that dumped eleven readings on you in one night is one
 * line on the board tomorrow morning, and the eleven are still eleven tasks
 * with eleven due dates underneath it.
 *
 * An `<li>` holding a nested list rather than a sibling of the cards, so
 * folding it removes exactly what it looks like it removes and no card can end
 * up orphaned between two headers.
 */
function GroupRow({
  group,
  tasks,
  folded,
  onFold,
  onRename,
  onUngroup,
  selection,
  children,
}: {
  group: TaskGroup;
  tasks: Task[];
  folded: boolean;
  onFold: () => void;
  onRename: (title: string) => void;
  onUngroup: () => void;
  selection: Selection;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.title);
  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <li className="group">
      <div className="group-head">
        <button
          className="group-fold"
          onClick={onFold}
          aria-expanded={!folded}
          title={folded ? "Show what is in it" : "Fold it away"}
        >
          <span className={`caret${folded ? "" : " down"}`} aria-hidden="true" />
        </button>

        {editing ? (
          <form
            className="grow"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(draft);
              setEditing(false);
            }}
          >
            <input
              autoFocus
              className="group-rename"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                onRename(draft);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(group.title);
                  setEditing(false);
                }
              }}
            />
          </form>
        ) : (
          <button
            className="grow group-title"
            onClick={() => {
              setDraft(group.title);
              setEditing(true);
            }}
            title="Rename"
          >
            {group.title}
          </button>
        )}

        <span className="count">
          {done ? `${tasks.length - done}/${tasks.length}` : tasks.length}
        </span>
        {/* One verb, and it is the harmless one. See `ungroup` above: there is
            no button on a group that can delete work. */}
        <button className="link group-ungroup" onClick={onUngroup}>
          Ungroup
        </button>
      </div>

      {folded ? (
        <p className="muted small group-folded" onClick={onFold} role="presentation">
          {tasks.length} inside
          {selection.count > 0 && tasks.some((t) => selection.has(t.id))
            ? " · some selected"
            : ""}
        </p>
      ) : (
        <ul className="list cards group-cards">{children}</ul>
      )}
    </li>
  );
}

/**
 * One class's cards, in the by-class arrangement.
 *
 * The section is a drop target, and dropping into it reassigns the class —
 * the same rule the columns follow, applied to what this arrangement is made
 * of. There is no status drop here on purpose: a section is not a state, and a
 * card's column is still one click away inside it.
 */
function ClassSection({
  cls,
  count,
  done,
  doneOpen,
  onToggleDone,
  onOpenClass,
  finished,
  children,
}: {
  cls: Class | null;
  count: number;
  done: number;
  doneOpen: boolean;
  onToggleDone: () => void;
  onOpenClass?: (id: string) => void;
  /*
   * A list of its own, rather than more rows appended to the live one.
   *
   * A group with one reading left and three finished appears in both halves,
   * and two headers carrying the same id as siblings of one list is a
   * duplicate key — React keeps the first and quietly drops the cards under
   * the second. Two lists, two key spaces, and the visual break between live
   * work and history is one the section wanted anyway.
   */
  finished: React.ReactNode;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `class:${cls ? cls.id : "none"}`,
  });

  return (
    <section
      ref={setNodeRef}
      className={`column class-section ${cls ? `hue-${cls.color}` : "hue-none"}${
        isOver ? " over" : ""
      }`}
      aria-label={cls ? cls.name : "No class"}
    >
      <h2>
        {cls && onOpenClass ? (
          <button className="link" onClick={() => onOpenClass(cls.id)}>
            {cls.name}
          </button>
        ) : (
          cls?.name ?? "No class"
        )}
        <span className="count">{count}</span>
      </h2>

      {count === 0 && !done ? (
        <p className="muted small">Nothing here.</p>
      ) : (
        <ul className="list cards">{children}</ul>
      )}

      {/* Everything finished, behind one line. A Done column repeated once per
          course is six columns of history standing in front of the work. */}
      {done > 0 && (
        <button className="link section-done" onClick={onToggleDone}>
          {doneOpen ? "Hide finished" : `… ${done} done`}
        </button>
      )}
      {doneOpen && <ul className="list cards section-finished">{finished}</ul>}
    </section>
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

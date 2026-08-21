import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import * as db from "../lib/db";
import type { Class, Task, TaskGroup, TaskStatus } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import {
  COLUMNS,
  cluster,
  flatten,
  groupByColumn,
  isOverdue,
  reorder,
  type BoardRow,
} from "../lib/board";
import { errorText, toast, undoable } from "../lib/toast";
import { useSelection, type Selection } from "../hooks/useSelection";
import BoardColumn from "./BoardColumn";
import TaskCard, { type DropEdge } from "./TaskCard";
import TaskDialog from "./TaskDialog";
import SelectionBar from "./SelectionBar";
import EstimatePicker from "./EstimatePicker";
import ClassPicker from "./ClassPicker";

/**
 * `?dnd=debug` in the address bar narrates the drag as it happens.
 *
 * A touch drag can only be watched on the device it is happening on, where
 * there is no console and no second hand free. Read once, so it cannot be
 * turned on by a re-render.
 */
const DEBUG =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("dnd") === "debug";

function trace(what: string) {
  if (DEBUG) toast(what);
}

/** A finger that lifted a card and put it back down where it found it. */
function stationaryTouch(e: DragEndEvent | DragCancelEvent): boolean {
  const byTouch = String((e.activatorEvent as Event | null)?.type).startsWith(
    "touch",
  );
  return byTouch && Math.abs(e.delta.x) < 8 && Math.abs(e.delta.y) < 8;
}

/** Toggle one, said in the language `select` already speaks. */
const TOUCH_TOGGLE = { ctrlKey: true, metaKey: false, shiftKey: false };

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
 * re-estimated, reassigned, grouped or deleted together. That is not a
 * power-user flourish: the week a term actually breaks is the week eleven
 * readings arrive from one course, and doing anything to eleven cards one at a
 * time is how a board stops being opened.
 *
 * Since migration 0016 a column is in hand-chosen order and nothing on this
 * screen rearranges itself. That makes a drop a richer gesture than it was —
 * where in the column, into which group, or out of one — and the three of them
 * are one drag, resolved together in `onDragEnd` below. A group can be picked
 * up by its header and moved as the block it looks like.
 *
 * Nothing here reaches the Week. A group is a label, an order is an order, and
 * the plan is still drawn from due dates, estimates and blocks — which is the
 * promise that lets all of this exist on the board without the planner having
 * to know it happened.
 */
export default function TaskBoard({
  store,
  emptyFor,
  onOpenClass,
  classId,
}: {
  store: DataStore;
  /** Named when the board is showing one class, so the empty state can say so. */
  emptyFor?: string;
  onOpenClass?: (id: string) => void;
  /**
   * Show only one course's cards — the Tasks tab inside a class.
   *
   * A filter rather than a pre-filtered store, which is what this used to be
   * given. Ordering is the reason: positions are numbered across a whole
   * column, and a board that could only see six of its forty cards would
   * renumber those six over the top of the other thirty-four. So the board
   * always holds the full column and draws a subset of it.
   */
  classId?: string;
}) {
  const { tasks, classes, groups, setTasks, setGroups, userId } = store;
  const [dragging, setDragging] = useState<Dragging | null>(null);
  /** Where a release right now would land. Drawn as a line between cards. */
  const [dropAt, setDropAt] = useState<{ id: string; edge: DropEdge } | null>(null);
  /** Groups the reader has folded shut. Ids, so a rename cannot lose one. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  /** Non-null while the selection bar is asking what to call a new group. */
  const [naming, setNaming] = useState<string | null>(null);
  /** The task whose dialog is open, by id — so an edit elsewhere is picked up. */
  const [editing, setEditing] = useState<string | null>(null);

  /*
   * A mouse and a finger want opposite activation rules, which is why this is
   * two sensors rather than one PointerSensor.
   *
   * A mouse gets distance: a drag must not start on a click aimed at the Open
   * button, and must not cost a held pause when it is a real drag.
   *
   * A finger cannot get distance, and this is the whole of the bug it fixes:
   * a touch that moves five pixels on a scrollable column has already been
   * claimed by the browser as a scroll, and the pointercancel that follows
   * killed the drag before it began — dragging did nothing at all on a phone.
   * The fix everyone reaches for first is touch-action: none on the cards,
   * which trades it for a board you cannot scroll past the third card. So the
   * gesture is separated in time instead: hold briefly and it is a drag, move
   * first and it is a scroll. Tolerance is what keeps a hold that trembles
   * from being read as the scroll it is not.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
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
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  /**
   * The full columns, and the ones actually on screen.
   *
   * Two passes over the same data on purpose. `full` is what positions are
   * written against — the whole column, whether or not this view is showing
   * all of it — and `shown` is what is drawn. On the To do page they are the
   * same list; inside a class they are not, and every index the drag code
   * computes is translated from one to the other by `fullIndex` below.
   */
  const full = useMemo(() => {
    const columns = groupByColumn(tasks);
    return Object.fromEntries(
      COLUMNS.map(({ status }) => [status, flatten(cluster(columns[status], groupById))]),
    ) as Record<TaskStatus, Task[]>;
  }, [tasks, groupById]);

  const shown = useMemo(() => {
    const visible = classId ? tasks.filter((t) => t.class_id === classId) : tasks;
    const columns = groupByColumn(visible);
    return Object.fromEntries(
      COLUMNS.map(({ status }) => [status, cluster(columns[status], groupById)]),
    ) as Record<TaskStatus, BoardRow[]>;
  }, [tasks, classId, groupById]);

  const shownFlat = useMemo(
    () =>
      Object.fromEntries(
        COLUMNS.map(({ status }) => [status, flatten(shown[status])]),
      ) as Record<TaskStatus, Task[]>,
    [shown],
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
   * A card inside a folded group is not in this list. It is not on screen, and
   * a selection that reaches something the person cannot see is one bulk
   * Delete away from being the worst bug in the app — see the note in
   * useSelection about stranded ids.
   */
  const order = useMemo(() => {
    const ids: string[] = [];
    for (const { status } of COLUMNS) {
      for (const row of shown[status]) {
        if (row.kind === "task") ids.push(row.task.id);
        else if (!folded.has(row.group.id)) {
          for (const t of row.tasks) ids.push(t.id);
        }
      }
    }
    return ids;
  }, [shown, folded]);

  const selection = useSelection(order);

  const chosen = useMemo(
    () =>
      order
        .filter((id) => selection.has(id))
        .map((id) => taskById.get(id))
        .filter((t): t is Task => Boolean(t)),
    // Walked in reading order rather than selection order, so a multi-card
    // drag lands in the arrangement it was picked up in rather than the order
    // the clicks happened to happen in.
    [order, selection.selected, taskById],
  );

  /* --- Dragging ------------------------------------------------------------ */

  /**
   * Which droppable a release would hit.
   *
   * The default cannot be used here and the reason is geometric: a column is a
   * droppable that *contains* every card in it, so any overlap test comparing
   * areas hands the column the win every time and no card is ever hit. The
   * board would then have exactly one answer per column — the end of it —
   * which is the behaviour this whole change exists to replace.
   *
   * So it is resolved in two steps, the way the eye does it. The pointer picks
   * the column. Then, inside that column only, the nearest card or header to
   * the card being dragged is the target — nearest to the *card*, not to the
   * pointer, because the card is the thing whose landing place is being chosen
   * and the pointer is only wherever it happened to be grabbed.
   *
   * Below the last row is bare space, and bare space is the column itself:
   * the end of it, and out of any group. That is the way out of a group with
   * no other gesture attached to it, so it has to stay reachable rather than
   * being swallowed by the nearest card twenty pixels above.
   *
   * Anything currently in the air is excluded. A card cannot be dropped
   * relative to itself, and a group offering its own header as a target would
   * be an invitation to a no-op.
   */
  const collision: CollisionDetection = (args) => {
    const held =
      dragging?.kind === "group"
        ? new Set([
            groupHandleId(
              dragging.tasks[0].status,
              dragging.group,
              dragging.tasks[0],
            ),
          ])
        : new Set<string>();
    held.add(String(args.active.id));

    const column = pointerWithin(args).find((c) => String(c.id).startsWith("col:"));
    if (!column) return closestCenter(args);
    const status = String(column.id).slice(4);

    const inside = args.droppableContainers.filter((c) => {
      const id = String(c.id);
      if (held.has(id) || id.startsWith("col:")) return false;
      const head = parseGroupHandle(id);
      if (head) return head.status === status;
      return (c.data.current as { status?: string } | undefined)?.status === status;
    });
    if (!inside.length) return [column];

    // Bare space below everything. Measured against the pointer, because this
    // is a question about where the hand is rather than where the card is —
    // and a tall card dragged low would otherwise never be able to reach it.
    const floor = inside.reduce((low, c) => {
      const rect = c.rect.current;
      return rect ? Math.max(low, rect.top + rect.height) : low;
    }, 0);
    if ((args.pointerCoordinates?.y ?? 0) > floor) return [column];

    const near = closestCenter({ ...args, droppableContainers: inside });
    return near.length ? near : [column];
  };

  function onDragStart(e: DragStartEvent) {
    // The lift is the only thing that says the hold registered, and on a
    // phone the card is under a finger while it happens.
    if (String((e.activatorEvent as Event | null)?.type).startsWith("touch")) {
      navigator.vibrate?.(10);
    }
    trace(`start · ${e.active.id}`);

    const id = String(e.active.id);
    const head = parseGroupHandle(id);
    if (head) {
      const row = shown[head.status].find(
        (r) => r.kind === "group" && r.group.id === head.groupId,
      );
      if (row && row.kind === "group") {
        setDragging({ kind: "group", group: row.group, tasks: row.tasks });
      }
      return;
    }
    const task = taskById.get(id);
    if (task) setDragging({ kind: "task", task });
  }

  function onDragOver(e: DragOverEvent) {
    const target = resolve(e);
    setDropAt(
      target && target.kind === "card" ? { id: target.overId, edge: target.edge } : null,
    );
  }

  /**
   * Dropping. Three questions, one gesture.
   *
   * *Which column* — the one the card was released in, which is the only
   * reading of a board that has never surprised anybody.
   *
   * *Where in it* — above or below whichever card the pointer was over when it
   * came up, or the end of the column if it was released on bare space. This
   * is new, and it is the whole of migration 0016: the column no longer sorts
   * itself, so this is now the only thing that decides the order.
   *
   * *Which group* — the group of the card it landed next to. Which means
   * dropping onto a card inside a group joins that group, dropping onto a
   * loose card leaves whatever group it was in, and bare column space is the
   * way out of a group with nothing else attached to it. One rule, read off
   * what is under the cursor, rather than three gestures to remember.
   *
   * A card that is part of the selection brings the selection with it — the
   * only reading of dragging one of four highlighted cards that is not a
   * surprise. A card outside the selection is just itself, and leaves the
   * selection alone rather than silently clearing it.
   *
   * A group brings its cards and keeps them: dropping a header never merges
   * two groups, because there is no such thing as a group inside a group and
   * the alternative is a gesture that can silently swallow eleven readings.
   */
  /*
   * A lift the browser took back.
   *
   * A finger that has lifted a card and not moved it is a finger resting on a
   * page the browser still thinks it might be asked to scroll, magnify or
   * select from — and any of those arrives as a cancel rather than an end.
   * Losing the drag there is right; losing the *selection* is not, because to
   * the person holding the phone nothing happened at all. So a cancelled lift
   * that never travelled still answers "this one".
   */
  function onDragCancel(e: DragCancelEvent) {
    trace(`cancel · ${Math.round(e.delta.x)},${Math.round(e.delta.y)}`);
    const held = dragging;
    setDragging(null);
    setDropAt(null);
    if (held?.kind === "task" && stationaryTouch(e)) {
      selection.select(held.task.id, TOUCH_TOGGLE);
    }
  }

  function onDragEnd(e: DragEndEvent) {
    trace(`end · ${Math.round(e.delta.x)},${Math.round(e.delta.y)} · over ${e.over?.id ?? "nothing"}`);
    const held = dragging;
    setDragging(null);
    setDropAt(null);
    if (!held) return;

    /*
     * A lift that never travelled is not a move — it is the touchscreen's
     * ctrl-click.
     *
     * A finger has no modifier to hold, so the hold that picks a card up is
     * also the only gesture available for "this one". Which of the two it was
     * is answered at the end rather than the start, by the finger: move and it
     * is the move it looked like all along, let go where you started and the
     * card goes back and is selected instead. The check has to come before the
     * target is resolved, because the card under a card released in place is
     * its neighbour, and that would be a silent reorder.
     */
    if (stationaryTouch(e)) {
      if (held.kind === "task") selection.select(held.task.id, TOUCH_TOGGLE);
      return;
    }

    const target = resolve(e);
    if (!target) return; // released over nothing: no-op, not a delete

    if (held.kind === "group") {
      const index =
        target.kind === "card"
          ? cardIndex(target)
          : full[target.status].length;
      void place(held.tasks, target.status, index, undefined);
      return;
    }

    const moving =
      selection.count > 1 && selection.has(held.task.id) ? chosen : [held.task];
    const index =
      target.kind === "card" ? cardIndex(target) : full[target.status].length;
    const groupId = target.kind === "card" ? target.groupId : null;
    void place(moving, target.status, index, groupId);
  }

  /**
   * Turn a drop onto a specific card into an index in the *full* column.
   *
   * The visible list and the real one differ inside a class, and the person is
   * pointing at the visible one. So the neighbour is identified by identity —
   * this card, the one under the cursor — and then looked up in the full
   * column, which is where positions are actually numbered.
   */
  function cardIndex(target: Extract<Target, { kind: "card" }>): number {
    const list = full[target.status];
    const at = list.findIndex((t) => t.id === target.overId);
    if (at === -1) return list.length;
    return target.edge === "after" ? at + 1 : at;
  }

  /**
   * Write a landing: new order, and whatever else the drop meant.
   *
   * Optimistic, like every other direct-manipulation gesture here, and for the
   * same reason: a card that springs back for 200ms while a round trip lands
   * reads as the app fighting you.
   *
   * `groupId` of `undefined` means "leave the grouping alone" — what a group
   * drag and a bulk column button want. `null` means "out of whatever group
   * you were in", which is what bare column space means.
   */
  async function place(
    moving: Task[],
    status: TaskStatus,
    index: number,
    groupId: string | null | undefined,
  ) {
    if (!moving.length) return;
    const updates = reorder(full[status], moving, index);
    if (!updates.length) return;

    const movingIds = new Set(moving.map((t) => t.id));
    const payload = updates.map((u) => {
      if (!movingIds.has(u.id)) return u;
      const task = taskById.get(u.id);
      return {
        ...u,
        status,
        ...(groupId === undefined ? {} : { group_id: groupId }),
        // The same narrow rule db.moveTask has always applied: this flag means
        // "you disagreed with a decision sync made", not "you touched a card".
        ...(task?.auto_completed && status !== "done"
          ? { status_overridden: true }
          : {}),
      };
    });

    const previous = tasks;
    const patchById = new Map(payload.map((p) => [p.id, p]));
    setTasks((prev) =>
      prev.map((t) => {
        const patch = patchById.get(t.id);
        return patch ? { ...t, ...patch } : t;
      }),
    );

    try {
      const saved = await db.reorderTasks(payload);
      const byId = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
    } catch (e) {
      setTasks(previous);
      toast(errorText(e, "Could not move that"), "error");
    }
  }

  /* --- Everything that acts on more than one card -------------------------- */

  /** The column buttons on the selection bar. Lands at the end, keeps groups. */
  function moveMany(list: Task[], status: TaskStatus) {
    const moving = list.filter((t) => t.status !== status);
    if (!moving.length) return;
    void place(moving, status, full[status].length, undefined);
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

  /* --- Editing and removing ------------------------------------------------ */

  /**
   * A saved edit goes straight into the list rather than through a refresh.
   *
   * The one thing the dialog can change that the board has to think about is
   * the column: a card moved by the select rather than by a drag has no
   * opinion about where in its new column it belongs, so it is appended. Last
   * is the honest answer to a gesture that named a column and nothing else.
   */
  function saved(before: Task, after: Task) {
    setTasks((prev) => prev.map((t) => (t.id === after.id ? after : t)));
    if (after.status !== before.status) {
      void place([after], after.status, full[after.status].length, undefined);
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

  const open = editing ? taskById.get(editing) ?? null : null;

  if (!shownFlat.todo.length && !shownFlat.doing.length && !shownFlat.done.length) {
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
        onOpen={(t) => setEditing(t.id)}
        onOpenClass={onOpenClass}
        selected={selection.has(task.id)}
        onSelect={(e) => selection.select(task.id, e)}
        selecting={selection.count > 0}
        dropEdge={dropAt?.id === task.id ? dropAt.edge : undefined}
      />
    );
  }

  function rows(status: TaskStatus) {
    return shown[status].map((row) =>
      row.kind === "task" ? (
        card(row.task)
      ) : (
        <GroupRow
          key={row.group.id}
          group={row.group}
          status={status}
          tasks={row.tasks}
          folded={folded.has(row.group.id)}
          held={dragging?.kind === "group" && dragging.group.id === row.group.id}
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
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="board">
        {COLUMNS.map(({ status, label }) => (
          <BoardColumn
            key={status}
            status={status}
            label={label}
            count={shownFlat[status].length}
            empty={EMPTY[status]}
          >
            {rows(status)}
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
            {dragging.kind === "group"
              ? `${dragging.group.title} · ${dragging.tasks.length}`
              : selection.count > 1 && selection.has(dragging.task.id)
                ? `${selection.count} tasks`
                : dragging.task.title}
          </div>
        )}
      </DragOverlay>

      {open && (
        <TaskDialog
          task={open}
          classes={classes}
          userId={userId}
          onSaved={(next) => saved(open, next)}
          onDelete={() => remove(open)}
          onClose={() => setEditing(null)}
        />
      )}

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
                onClick={() => moveMany(chosen, status)}
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

type Dragging =
  | { kind: "task"; task: Task }
  | { kind: "group"; group: TaskGroup; tasks: Task[] };

/** What a release right now would mean. */
type Target =
  | { kind: "card"; status: TaskStatus; overId: string; edge: DropEdge; groupId: string | null }
  | { kind: "column"; status: TaskStatus };

/**
 * Read the drop target off the event.
 *
 * Three shapes of droppable, and they are told apart by a prefix on the id
 * rather than by a lookup: `col:` is bare column space, `head:` is a group's
 * header, and anything else is a task id — which is also the card's draggable
 * id, exactly as every sortable list is built.
 */
function resolve(e: DragOverEvent | DragEndEvent): Target | null {
  const over = e.over;
  if (!over) return null;
  const id = String(over.id);

  const column = parseColumn(id);
  if (column) return { kind: "column", status: column };

  const head = parseGroupHandle(id);
  if (head) {
    // Landing on a header means joining that group at its top. The header sits
    // above every card in the group, so "above the first card" is the only
    // reading of the gesture that matches where the pointer actually was.
    return {
      kind: "card",
      status: head.status,
      overId: head.firstTaskId,
      edge: "before",
      groupId: head.groupId,
    };
  }

  const data = over.data.current as { status?: TaskStatus; groupId?: string | null } | undefined;
  if (!data?.status) return null;

  /*
   * Above or below, decided by the dragged card's own centre against the
   * centre of the one it is over. Using the pointer instead reads worse: the
   * pointer is wherever the card was grabbed, so picking a card up by its
   * bottom edge would make every drop mean "below", which is a board that
   * ignores half of what you tell it.
   */
  const rect = e.active.rect.current.translated;
  const mine = rect ? rect.top + rect.height / 2 : over.rect.top;
  const theirs = over.rect.top + over.rect.height / 2;

  return {
    kind: "card",
    status: data.status,
    overId: id,
    edge: mine < theirs ? "before" : "after",
    groupId: data.groupId ?? null,
  };
}

function parseColumn(id: string): TaskStatus | null {
  if (!id.startsWith("col:")) return null;
  return id.slice(4) as TaskStatus;
}

/** "head:<status>:<groupId>:<firstTaskId>". */
function parseGroupHandle(
  id: string,
): { status: TaskStatus; groupId: string; firstTaskId: string } | null {
  if (!id.startsWith("head:")) return null;
  const [, status, groupId, firstTaskId] = id.split(":");
  return { status: status as TaskStatus, groupId, firstTaskId };
}

export function groupHandleId(status: TaskStatus, group: TaskGroup, first: Task): string {
  return `head:${status}:${group.id}:${first.id}`;
}

/**
 * A group, drawn as a header with its cards under it.
 *
 * Folded, it is one line saying a name and a number. That is the entire
 * feature: a course that dumped eleven readings on you in one night is one
 * line on the board tomorrow morning, and the eleven are still eleven tasks
 * with eleven due dates underneath it.
 *
 * The header is the handle. A group behaves like the block it looks like —
 * picked up whole, dropped whole, its cards keeping their order inside it —
 * because a header that could only be folded and renamed was a label lying on
 * top of a board where everything else could be moved. Renaming and Ungroup
 * still click through: the drag sensor waits five pixels, so a press that does
 * not travel is a press.
 *
 * An `<li>` holding a nested list rather than a sibling of the cards, so
 * folding it removes exactly what it looks like it removes and no card can end
 * up orphaned between two headers.
 */
function GroupRow({
  group,
  status,
  tasks,
  folded,
  held,
  onFold,
  onRename,
  onUngroup,
  selection,
  children,
}: {
  group: TaskGroup;
  status: TaskStatus;
  tasks: Task[];
  folded: boolean;
  /** This group is the thing currently in the air. */
  held: boolean;
  onFold: () => void;
  onRename: (title: string) => void;
  onUngroup: () => void;
  selection: Selection;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.title);
  const done = tasks.filter((t) => t.status === "done").length;
  const late = tasks.filter((t) => isOverdue(t)).length;

  const handle = groupHandleId(status, group, tasks[0]);
  const { attributes, listeners, setNodeRef } = useDraggable({ id: handle });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: handle });

  return (
    <li className={`group${held ? " dragging" : ""}${isOver ? " drop-into" : ""}`}>
      <div
        className="group-head"
        ref={(node) => {
          setNodeRef(node);
          setDropRef(node);
        }}
        {...listeners}
        {...attributes}
      >
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

        {/*
          The header carries the overdue warning for what is inside it, which
          matters more now than it used to: nothing floats to the top of a
          column any more, and a folded group is otherwise a line that can hide
          a missed deadline behind a number.
        */}
        {late > 0 && (
          <span className="error small group-late" title="Overdue inside">
            {late} late
          </span>
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

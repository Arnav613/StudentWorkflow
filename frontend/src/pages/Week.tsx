import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import * as db from "../lib/db";
import { getCalendar } from "../lib/api";
import { errorText, toast, undoable } from "../lib/toast";
import { formatDue } from "../lib/board";
import {
  PLAN_DAYS,
  SLOT_MINUTES,
  addDays,
  blockMinutes,
  byDay,
  classMedians,
  clockOf,
  clockOfMinutes,
  formatMinutes,
  hhmmOf,
  isoDate,
  planDays,
  planWeek,
  snapUp,
  unscheduled,
} from "../lib/schedule";
import {
  GRID_START_MIN,
  GRID_MINUTES,
  classForEvent,
  geometry,
  hourMarks,
  insertAt,
  instantOf,
  layoutDay,
  snapToSlot,
  minutesFrom,
  spanOf,
  type Placed,
} from "../lib/weekgrid";
import {
  useSelection,
  isSelectClick,
  type Selection,
  type SelectModifiers,
} from "../hooks/useSelection";
import RoutinesPanel from "../components/RoutinesPanel";
import SelectionBar from "../components/SelectionBar";
import EstimatePicker from "../components/EstimatePicker";
import ClassPicker from "../components/ClassPicker";
import ScopeDialog, { type Scope } from "../components/ScopeDialog";
import TimePicker from "../components/TimePicker";
import type { DataStore } from "../hooks/useData";
import type {
  Class,
  ClassSession,
  PlanBlock,
  Routine,
  RoutineOverride,
  RoutineSkip,
  Task,
} from "../lib/types";

const DAYS = PLAN_DAYS;

/** Shorter than this and the name cannot be read at any scale worth having. */
const SLIVER_MINUTES = 45;

/**
 * The Week: seven days drawn to scale, and what you have decided to do in them.
 *
 * The board answers "what is due". This answers "when will I do it", which is
 * the question a deadline list stops being able to answer somewhere around
 * week four.
 *
 * It used to answer it as seven lists of cards, and a list is the one shape
 * that cannot say *how much*: a half-hour errand and a four-hour essay drew
 * the same card, so a brutal Thursday and an empty Sunday looked alike. There
 * was a separate Forecast tab drawing the bar chart that did say it, which
 * meant the truth about your week lived on a screen you could not touch and
 * the screen you could touch was the one telling the comfortable lie.
 *
 * They are one thing now. Each day is a bar growing off an axis — 8am at the
 * foot, 11pm at the head — where a block's height *is* its length and the space
 * left over is free time you can drop into. Classes, work and routines sit in
 * the order the day actually runs, not grouped by kind, because "two hours of
 * study" is a different fact from "two hours of study starting at nine".
 *
 * A block shows a name and a colour and nothing else. Everything else — the
 * times, the class, the deadline — is one click away, over the top of the
 * column rather than inside it, so opening a card never moves the chart.
 *
 * Regenerate is a button and never a side effect. A plan that reshuffles
 * itself while you are reading it is not a plan, it is a slot machine.
 *
 * Everything on the grid is a row in `plan_blocks` — work, routines and
 * lectures alike. Lectures are mirrored from Google (see `db.syncCalendar`),
 * so one you are not attending can be dragged off the board like anything
 * else — locally, never back to Google.
 */
export default function WeekPage({
  store,
  onOpenClass,
}: {
  store: DataStore;
  onOpenClass: (id: string) => void;
}) {
  const {
    classes,
    tasks,
    routines,
    routineOverrides,
    routineSkips,
    planBlocks,
    planFrom,
    refresh,
    setPlanBlocks,
    setTasks,
    userId,
  } = store;
  const [generating, setGenerating] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [calendarGranted, setCalendarGranted] = useState<boolean | null>(null);
  /** The one block showing its details. At most one, over the top of the grid. */
  const [openId, setOpenId] = useState<string | null>(null);

  /*
   * The seven tracks, by column, so a drop can measure the one it landed in.
   *
   * dnd-kit hands back the rect it measured when the drag began. That is the
   * right answer until the grid scrolls under the cursor — which it does the
   * moment a week runs past bedtime — and then every drop is off by however
   * far it scrolled. Reading the element live costs one layout and cannot
   * drift.
   */
  const tracks = useRef(new Map<number, HTMLElement>());

  const days = useMemo(() => planDays(planFrom, DAYS), [planFrom]);
  const medians = useMemo(() => classMedians(tasks), [tasks]);

  const classById = useMemo(
    () => new Map<string, Class>(classes.map((c) => [c.id, c])),
    [classes],
  );
  const taskById = useMemo(
    () => new Map<string, Task>(tasks.map((t) => [t.id, t])),
    [tasks],
  );
  const routineById = useMemo(
    () => new Map<string, Routine>(routines.map((r) => [r.id, r])),
    [routines],
  );

  /* --- What a lecture is, and what is on in it ---------------------------- */

  /**
   * Which calendar series belongs to which class, and this fortnight's
   * schedule — phase 10.
   *
   * Loaded here rather than in `useData` for the same reason the proposal
   * queue is: both are small, rare tables that only this screen and the class
   * tabs read, and putting them in the shared load would make every board
   * refresh pay for rows the board never looks at.
   */
  const [eventLinks, setEventLinks] = useState<Map<string, string>>(new Map());
  const [sessions, setSessions] = useState<ClassSession[]>([]);

  const loadSchedule = useCallback(async () => {
    try {
      const [links, rows] = await Promise.all([
        db.listClassEventLinks(),
        db.listSessionsBetween(isoDate(planFrom), isoDate(addDays(planFrom, DAYS))),
      ]);
      setEventLinks(new Map(links.map((l) => [l.google_series_id, l.class_id])));
      setSessions(rows);
    } catch {
      // Silent, and deliberately. Neither of these is the week: without them
      // the grid draws exactly what it drew before phase 10 existed, and a red
      // banner over a perfectly correct chart would be the app reporting its
      // own optional extra as a failure.
    }
  }, [planFrom]);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  /**
   * The class a lecture belongs to: the answer you gave, or nothing.
   *
   * Only a confirmed link counts. The title guess below is offered as a
   * suggestion in the picker and is never treated as an answer — showing
   * Tuesday's topic against a lecture matched on a substring would be the app
   * quietly asserting something nobody told it.
   */
  function linkedClassOf(block: PlanBlock): Class | null {
    const series = block.google_series_id ?? block.google_event_id;
    if (!series) return null;
    const id = eventLinks.get(series);
    return id ? classById.get(id) ?? null : null;
  }

  /** What is on in this lecture: the class's session for the day it falls on. */
  function sessionOf(block: PlanBlock): ClassSession | null {
    const cls = linkedClassOf(block);
    if (!cls) return null;
    const key = isoDate(new Date(block.starts_at));
    return (
      sessions.find((s) => s.class_id === cls.id && s.on_date === key) ?? null
    );
  }

  async function linkSeries(block: PlanBlock, classId: string) {
    const series = block.google_series_id ?? block.google_event_id;
    if (!series) return;
    try {
      if (classId) {
        await db.linkEventSeries({
          user_id: userId,
          google_series_id: series,
          class_id: classId,
        });
      } else {
        await db.unlinkEventSeries(series);
      }
      await loadSchedule();
    } catch (e) {
      toast(errorText(e, "Could not link that lecture"), "error");
    }
  }

  /*
   * The calendar refresh, behind the render rather than in front of it.
   *
   * The grid is already on screen by the time this runs — it is drawn from
   * plan_blocks, which includes the last open's lectures — so this is a
   * reconciliation, not a load. It only calls refresh() when something
   * actually moved, because re-rendering the week to arrive at the same seven
   * columns is a flicker charged for nothing.
   *
   * Every failure means the same thing: carry on with the copy we have. A dead
   * grant, a sleeping Render and a deployment with Google switched off are
   * three different problems and none of them is this screen's to report — the
   * Classes tab already owns the reconnect banner.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      let events;
      try {
        const res = await getCalendar(DAYS);
        if (!live) return;
        setCalendarGranted(res.granted);
        if (!res.granted) return;
        events = res.events;
      } catch {
        // Google, or the backend in front of it, did not answer. Nothing to
        // report: the planner works without it and the Classes tab owns the
        // reconnect prompt.
        if (live) setCalendarGranted(false);
        return;
      }

      try {
        // The far edge is now-plus-seven, matching what routers/calendar.py
        // asks Google for. Passing midnight-plus-seven instead left a sliver
        // of a day that Google reported on and the sweep did not cover.
        const changed = await db.syncCalendar(
          userId,
          events,
          planFrom,
          new Date(Date.now() + DAYS * 24 * 60 * 60_000),
        );
        if (changed && live) await refresh();
      } catch (e) {
        // The fetch worked and writing it down did not, which is this app's
        // fault rather than Google's — a schema behind the code, most likely.
        // Swallowing it here is how a week silently renders with no lectures
        // in it and no way to find out why.
        if (live) toast(errorText(e, "Could not store your calendar"), "error");
      }
    })();
    return () => {
      live = false;
    };
    // Once per open. The plan horizon does not move while the tab is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- What goes where ---------------------------------------------------- */

  const onBoard = planBlocks.filter((b) => !b.dismissed);
  const blocksByDay = byDay(onBoard, days);

  /**
   * The geometry of all seven columns, and the axis they share.
   *
   * One scale for the whole grid. Letting each day scale to its own busiest
   * hour would make every column full and the comparison between them
   * meaningless, which is the failure mode of every "helpfully" auto-ranged
   * chart.
   */
  const laid: Placed<PlanBlock>[][] = useMemo(
    () => days.map((day, i) => layoutDay(day, blocksByDay[i])),
    // blocksByDay is rebuilt every render from planBlocks; that is the real
    // dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, planBlocks],
  );
  const span = spanOf(laid);
  const marks = hourMarks(span);

  /** Lectures you have not dropped: hours the planner may not use. */
  const busy = onBoard.filter((b) => b.google_event_id);
  /** Lectures you have dropped: they wait in the rail, and cost nothing. */
  const skipped = planBlocks.filter((b) => b.google_event_id && b.dismissed);

  const outstanding = unscheduled(tasks, onBoard, medians)
    .map((u) => ({ ...u, task: taskById.get(u.task_id) }))
    .filter((u): u is typeof u & { task: Task } => Boolean(u.task))
    .sort(
      (a, b) =>
        (Date.parse(a.task.due_at ?? "") || Infinity) -
        (Date.parse(b.task.due_at ?? "") || Infinity),
    );

  // Hours still ahead of you, not hours the plan once contained. Counting a
  // block that has already gone by would have the header call work planned
  // while the rail below it calls the same work unplanned — and the rail is
  // the one telling the truth.
  const plannedMinutes = onBoard
    .filter((b) => b.task_id && Date.parse(b.ends_at) > Date.now())
    .reduce((sum, b) => sum + blockMinutes(b), 0);

  const missed = outstanding.filter((u) => u.missed).length;

  /* --- Selecting several at once ------------------------------------------ */

  /*
   * The order a shift-range runs along, which on a chart is not obvious and
   * has to be chosen.
   *
   * Monday first, and within a day the earliest thing first — so a range reads
   * the way the week happens, not the way it is drawn. Drawn order would put
   * eleven at night before eight in the morning, since the column grows
   * upward, and "everything from here to there" would come out backwards on
   * every day of the week.
   *
   * The rail comes after all seven days. It is not part of the week's
   * chronology; it is what is left over, and left over goes last.
   */
  const order = useMemo(() => {
    const ids = laid.flatMap((column) =>
      [...column]
        .sort((a, b) => a.startMin - b.startMin)
        .map((p) => `block:${p.item.id}`),
    );
    for (const u of outstanding) ids.push(`task:${u.task_id}`);
    for (const b of skipped) ids.push(`block:${b.id}`);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid, planBlocks, tasks]);

  const selection = useSelection(order);

  const blockById = useMemo(
    () => new Map(planBlocks.map((b) => [b.id, b])),
    [planBlocks],
  );

  /** The selected plan blocks, in whatever order the set came out. */
  const chosenBlocks = useMemo(
    () =>
      [...selection.selected]
        .filter((id) => id.startsWith("block:"))
        .map((id) => blockById.get(id.slice(6)))
        .filter((b): b is PlanBlock => Boolean(b)),
    [selection.selected, blockById],
  );

  /**
   * The tasks behind the selection.
   *
   * A block and a rail item are two things on screen and one thing in the
   * database, so anything that acts on a *task* — an estimate, a class, Done,
   * a delete — collapses them. Selecting a block and its own rail entry counts
   * once, which is the only answer that does not make "3 selected" delete two
   * things.
   */
  const chosenTasks = useMemo(() => {
    const ids = new Set<string>();
    for (const id of selection.selected) {
      if (id.startsWith("task:")) ids.add(id.slice(5));
      else {
        const b = blockById.get(id.slice(6));
        if (b?.task_id) ids.add(b.task_id);
      }
    }
    return [...ids].map((id) => taskById.get(id)).filter((t): t is Task => Boolean(t));
  }, [selection.selected, blockById, taskById]);

  /**
   * What colour a block carries.
   *
   * Work takes its class's hue, which is the whole point of class colours —
   * the same essay is the same colour on every screen in the app. A routine
   * takes the one reserved shade, because "not work" is a category rather than
   * a class. A lecture is matched to a class by name where it can be, since
   * Google sends a string and nothing else, and grey where it cannot.
   */
  function hueOf(block: PlanBlock): string {
    if (block.routine_id) return "hue-routine";
    if (block.google_event_id) {
      // The answer first, the guess second. Before phase 10 a lecture could
      // only ever be matched on its title; now that a person can say which
      // class it is, what they said outranks what the string looked like.
      const linked = linkedClassOf(block);
      if (linked) return `hue-${linked.color}`;
      const guess = classForEvent(block.title, classes);
      return guess ? `hue-${guess.color}` : "hue-none";
    }
    const task = block.task_id ? taskById.get(block.task_id) : null;
    const cls = task?.class_id ? classById.get(task.class_id) : null;
    return cls ? `hue-${cls.color}` : "hue-none";
  }

  async function regenerate() {
    setGenerating(true);
    try {
      // The scheduler takes intervals, not titles. It is given the lectures
      // because they are the same shape; it has no idea what any of them are,
      // and that is the correct amount for a scheduler to know.
      //
      // `from` is now, not planFrom: today's morning is over and nothing can
      // be scheduled into it. The columns still start at midnight so the week
      // reads as a week.
      const plan = planWeek({
        tasks,
        routines,
        busy,
        locked: onBoard.filter((b) => b.locked && !b.google_event_id),
        routineOverrides,
        from: new Date(),
        days: DAYS,
        medians,
      });

      await db.replacePlan(userId, new Date(), plan.blocks);
      await refresh();

      if (plan.unplaced.length) {
        const beyond = plan.unplaced.filter((u) => u.reason === "deadline").length;
        toast(
          beyond
            ? `Planned. ${beyond} thing${beyond === 1 ? "" : "s"} cannot fit before ${beyond === 1 ? "its" : "their"} deadline.`
            : `Planned. ${plan.unplaced.length} thing${plan.unplaced.length === 1 ? "" : "s"} did not fit your hours this week.`,
          "info",
        );
      } else {
        toast("Week planned", "success");
      }
    } catch (e) {
      toast(errorText(e, "Could not plan the week"), "error");
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Put the calendar back the way Google has it.
   *
   * The background sync keeps your local edits on purpose — a lecture you
   * moved keeps your time, a lecture you dropped stays dropped — which is
   * right until the board has drifted far enough that repairing it block by
   * block is worse than starting again. So the reset is a button, pressed
   * deliberately, and it says what it will lose before it does it.
   *
   * Only the mirror is reset. Work and routines are not Google's to restore
   * and are not touched.
   */
  async function resync() {
    setResyncing(true);
    try {
      const res = await getCalendar(DAYS);
      if (!res.granted) {
        setCalendarGranted(false);
        toast("No calendar access to sync with", "info");
        return;
      }
      await db.resyncCalendar(userId, res.events, planFrom);
      await refresh();
      toast("Calendar back in step with Google", "success");
    } catch (e) {
      toast(errorText(e, "Could not reach your calendar"), "error");
    } finally {
      setResyncing(false);
    }
  }

  /* --- Manual edits. All of these lock the block. See db.moveBlock. -------- */

  /*
   * Moved on screen first, saved second.
   *
   * This used to await the write and then a full refresh() before touching
   * state, so the card sprang back to where it came from, sat there for as
   * long as two round trips took, and then appeared somewhere else — the app
   * visibly undoing your drag and then re-doing it. A drag is direct
   * manipulation: the thing goes where you put it, and only a failure moves it
   * back.
   */
  async function commitMove(block: PlanBlock, start: Date, minutes?: number) {
    const length = minutes ?? blockMinutes(block);
    const starts_at = start.toISOString();
    const ends_at = new Date(start.getTime() + length * 60_000).toISOString();
    const previous = planBlocks;

    setPlanBlocks((prev) =>
      inOrder(
        prev.map((b) =>
          b.id === block.id
            ? { ...b, starts_at, ends_at, locked: true, dismissed: false }
            : b,
        ),
      ),
    );

    try {
      await db.moveBlock(block.id, starts_at, ends_at);
    } catch (e) {
      setPlanBlocks(previous);
      toast(errorText(e, "Could not move that block"), "error");
    }
  }

  /**
   * Push a run of blocks later to make room for something dropped among them.
   *
   * Optimistic like every other edit here, and deliberately *not* locking:
   * see `db.shiftBlock`. A block that moved because something else arrived is
   * not a decision anybody made, and pinning it would have one drag freeze a
   * whole evening against the next Replan.
   */
  async function applyShifts(
    day: Date,
    shifts: { block: PlanBlock; startMin: number }[],
  ) {
    if (!shifts.length) return;

    const moved = shifts.map(({ block, startMin }) => {
      const start = instantOf(day, startMin);
      return {
        id: block.id,
        starts_at: start.toISOString(),
        ends_at: new Date(
          start.getTime() + blockMinutes(block) * 60_000,
        ).toISOString(),
      };
    });
    const byId = new Map(moved.map((m) => [m.id, m]));

    const previous = planBlocks;
    setPlanBlocks((prev) =>
      inOrder(
        prev.map((b) => {
          const m = byId.get(b.id);
          return m ? { ...b, starts_at: m.starts_at, ends_at: m.ends_at } : b;
        }),
      ),
    );

    try {
      await Promise.all(
        moved.map((m) => db.shiftBlock(m.id, m.starts_at, m.ends_at)),
      );
    } catch (e) {
      setPlanBlocks(previous);
      toast(errorText(e, "Could not make room for that"), "error");
    }
  }

  /** The time on the card, changed on the card. Keeps the block's length. */
  async function retime(block: PlanBlock, hhmm: string) {
    if (!hhmm) return;
    const start = new Date(block.starts_at);
    const [h, m] = hhmm.split(":").map(Number);
    const next = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      h,
      m,
    );
    await commitMove(block, next);
    askScope(block, next);
  }

  /**
   * The other end of the block, changed the same way — and the estimate with
   * it.
   *
   * Only the start was editable here, which made the card able to say when
   * work begins and never how long it runs. Dragging the end of a block is
   * the most direct way anyone has ever said "this will take longer than you
   * thought", and the estimate is what that sentence is about: nothing splits
   * a task any more, so this block's length *is* the task's estimate, and
   * writing one without the other would leave Replan undoing the correction
   * the next time it ran.
   *
   * A routine or a lecture has no estimate to carry, and just gets longer.
   */
  async function resize(block: PlanBlock, hhmm: string) {
    if (!hhmm) return;
    const start = new Date(block.starts_at);
    const [h, m] = hhmm.split(":").map(Number);
    let end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      h,
      m,
    );
    // 11:30 pm to 12:30 am is a real, if unwise, evening. An end at or before
    // the start means the next day, not a mistake to refuse.
    if (end.getTime() <= start.getTime()) end = addDays(end, 1);

    const minutes = (end.getTime() - start.getTime()) / 60_000;
    await commitMove(block, start, minutes);
    if (!block.task_id) return;

    const task = taskById.get(block.task_id);
    if (!task) return;
    const previous = tasks;
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, estimate_minutes: minutes } : t)),
    );
    try {
      const saved = await db.updateTask(task.id, { estimate_minutes: minutes });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? saved : t)));
    } catch (e) {
      setTasks(previous);
      toast(errorText(e, "Could not save that estimate"), "error");
    }
  }

  /**
   * Offer to widen a routine move, but only when the day did not change.
   *
   * Dragging Tuesday's gym into Wednesday is not a statement about Wednesdays
   * — it is this week, this once, and asking "every Wednesday?" would invite
   * an answer that quietly leaves Tuesday empty. A change of time on the day
   * it already belonged to is the only one where the wider readings make
   * sense, and it is the one people actually make.
   */
  function askScope(block: PlanBlock, start: Date) {
    const routine = block.routine_id ? routineById.get(block.routine_id) : null;
    if (!routine) return;
    if (new Date(block.starts_at).getDay() !== start.getDay()) return;
    setAsking({
      verb: "move",
      block,
      routine,
      day: start,
      time_of_day: `${`${start.getHours()}`.padStart(2, "0")}:${`${start.getMinutes()}`.padStart(2, "0")}`,
    });
  }

  /**
   * Take something off the board.
   *
   * There is no button for this any more. Dragging a block into the Unplanned
   * rail is the gesture, and it is the same gesture that brings it back — a
   * Remove link beside it was a second way to say one thing, and the one that
   * could not be undone by reversing itself.
   *
   * A lecture is dismissed rather than deleted — the row is a mirror of
   * Google's, so a delete would last until the next refresh — and it lands in
   * the rail, where it can be dragged back. Work is deleted, and the task it
   * belonged to reappears in the rail on its own because its hours are no
   * longer accounted for. Either way the hole it leaves stays a hole: nothing
   * else in the day moves, because nothing else was asked to.
   */
  async function clear(block: PlanBlock) {
    /*
     * Removing one block of a routine used to remove the routine — every
     * Tuesday of it. Skipping one gym session is a far more ordinary thing to
     * want than giving up the gym, so removal asks the same three-way question
     * a move does, and nothing happens until it is answered.
     */
    if (block.routine_id) {
      const routine = routineById.get(block.routine_id);
      if (routine) {
        setAsking({
          verb: "remove",
          block,
          routine,
          day: new Date(block.starts_at),
        });
        return;
      }
    }

    const previous = planBlocks;
    setPlanBlocks((prev) =>
      block.google_event_id
        ? prev.map((b) => (b.id === block.id ? { ...b, dismissed: true } : b))
        : prev.filter((b) => b.id !== block.id),
    );
    try {
      if (block.google_event_id) await db.setDismissed(block.id, true);
      else await db.deleteBlock(block.id);
    } catch (e) {
      setPlanBlocks(previous);
      toast(errorText(e, "Could not remove that block"), "error");
    }
  }

  /* --- Everything that acts on more than one --------------------------- */

  /**
   * Take a selection off the grid.
   *
   * The same three outcomes `clear` has, applied without asking three
   * questions: work is deleted and its task falls back into the rail,
   * a lecture is dismissed because the row is Google's mirror.
   *
   * Routines are left where they are, on purpose. Removing one asks whether
   * you mean this Tuesday, every Tuesday, or the whole routine — and there is
   * no honest way to answer that on behalf of six blocks at once. Guessing the
   * narrowest reading would be the tempting version and it would silently
   * strand skip rows all over the term. So they are skipped and said aloud.
   */
  async function unplanMany() {
    const routines = chosenBlocks.filter((b) => b.routine_id).length;
    const work = chosenBlocks.filter((b) => !b.routine_id && !b.google_event_id);
    const lectures = chosenBlocks.filter((b) => b.google_event_id);
    if (!work.length && !lectures.length) {
      toast(
        routines
          ? "Routines come off one at a time — the question they ask has three answers."
          : "Nothing on the grid is selected",
        "info",
      );
      return;
    }

    const gone = new Set(work.map((b) => b.id));
    const hidden = new Set(lectures.map((b) => b.id));
    const previous = planBlocks;
    selection.clear();

    setPlanBlocks((prev) =>
      prev
        .filter((b) => !gone.has(b.id))
        .map((b) => (hidden.has(b.id) ? { ...b, dismissed: true } : b)),
    );

    try {
      await Promise.all([
        db.deleteBlocks([...gone]),
        db.setDismissedMany([...hidden], true),
      ]);
      toast(
        routines
          ? `Unplanned. ${routines} routine block${routines === 1 ? "" : "s"} left alone — those are removed one at a time.`
          : `${gone.size + hidden.size} taken off the week`,
        routines ? "info" : "success",
      );
    } catch (e) {
      setPlanBlocks(previous);
      toast(errorText(e, "Could not take those off"), "error");
    }
  }

  /** Mark the work behind the selection finished. Its hours stay where they are. */
  async function markDone() {
    const live = chosenTasks.filter((t) => t.status !== "done");
    if (!live.length) {
      toast("Nothing selected that is still outstanding", "info");
      return;
    }
    const ids = new Set(live.map((t) => t.id));
    const previous = tasks;
    setTasks((prev) =>
      prev.map((t) => (ids.has(t.id) ? { ...t, status: "done" as const } : t)),
    );
    try {
      const saved = await db.moveTasks(live, "done");
      const byId = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
      toast(`${live.length} marked done`, "success");
    } catch (e) {
      setTasks(previous);
      toast(errorText(e, "Could not mark those done"), "error");
    }
  }

  /**
   * One estimate, or one class, across the selection.
   *
   * An estimate also resizes the blocks, because on this screen a block's
   * length *is* the estimate — that invariant is what lets you correct a
   * guess by dragging the end of a block, and writing one without the other
   * would leave the next Replan undoing whichever half was missed.
   */
  async function patchMany(
    patch: Partial<Pick<Task, "class_id" | "estimate_minutes">>,
    said: string,
  ) {
    if (!chosenTasks.length) return;
    const ids = chosenTasks.map((t) => t.id);
    const idSet = new Set(ids);
    const previousTasks = tasks;
    const previousBlocks = planBlocks;

    const minutes = patch.estimate_minutes;
    const resized =
      minutes == null
        ? []
        : planBlocks
            .filter((b) => b.task_id && idSet.has(b.task_id))
            .map((b) => ({
              id: b.id,
              starts_at: b.starts_at,
              ends_at: new Date(
                Date.parse(b.starts_at) + minutes * 60_000,
              ).toISOString(),
            }));
    const byId = new Map(resized.map((r) => [r.id, r]));

    setTasks((prev) => prev.map((t) => (idSet.has(t.id) ? { ...t, ...patch } : t)));
    if (resized.length) {
      setPlanBlocks((prev) =>
        inOrder(
          prev.map((b) => {
            const r = byId.get(b.id);
            return r ? { ...b, ends_at: r.ends_at } : b;
          }),
        ),
      );
    }

    try {
      const saved = await db.updateTasks(ids, patch);
      const savedById = new Map(saved.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => savedById.get(t.id) ?? t));
      await Promise.all(
        resized.map((r) => db.shiftBlock(r.id, r.starts_at, r.ends_at)),
      );
      toast(said, "success");
    } catch (e) {
      setTasks(previousTasks);
      setPlanBlocks(previousBlocks);
      toast(errorText(e, "Could not change those"), "error");
    }
  }

  /**
   * Delete the tasks behind the selection, hours and all.
   *
   * The destructive one, and separate from Unplan for exactly that reason:
   * taking work off the week and deciding the work does not exist are two
   * different sentences, and a single button that meant either would be
   * pressed for the first and do the second. Five seconds of undo, no dialog.
   */
  function deleteMany() {
    const list = chosenTasks;
    if (!list.length) {
      toast("Nothing selected that is a task", "info");
      return;
    }
    const ids = list.map((t) => t.id);
    const idSet = new Set(ids);
    const previousTasks = tasks;
    const previousBlocks = planBlocks;

    selection.clear();
    undoable({
      message: `Deleted ${ids.length} task${ids.length === 1 ? "" : "s"}`,
      apply: () => {
        setTasks((prev) => prev.filter((t) => !idSet.has(t.id)));
        // Their hours go with them on screen. The database does this itself —
        // plan_blocks.task_id cascades — but not until the grace period is up,
        // and a block left drawn against a deleted task is a ghost.
        setPlanBlocks((prev) =>
          prev.filter((b) => !(b.task_id && idSet.has(b.task_id))),
        );
      },
      commit: () => db.deleteTasks(ids),
      revert: () => {
        setTasks(previousTasks);
        setPlanBlocks(previousBlocks);
      },
      onError: () => toast("They are still there", "info"),
    });
  }

  /* --- "…and every Tuesday?" ---------------------------------------------- */

  /**
   * A routine block whose scope is still an open question.
   *
   * The two verbs ask the same three-way question and differ only in what the
   * answers do. A move has already happened by the time this is set — as the
   * narrowest reading, which is the only one safe to assume — so cancelling
   * leaves the one-off standing. A removal has not happened yet, because there
   * is no narrow reading of "delete" that is safe to assume, and cancelling
   * leaves everything alone.
   */
  type Ask = {
    verb: "move" | "remove";
    block: PlanBlock;
    routine: Routine;
    day: Date;
    /** Only on a move: the new time, as wall clock. */
    time_of_day?: string;
  };
  const [asking, setAsking] = useState<Ask | null>(null);

  /** Rewrite this routine's remaining blocks so an answer reaches the week. */
  async function rewrite(
    routine: Routine,
    overrides: RoutineOverride[],
    skips: RoutineSkip[],
  ) {
    await db.resyncRoutine(userId, routine, overrides, skips, new Date(), DAYS);
  }

  async function applyScope(scope: Scope) {
    const ask = asking;
    setAsking(null);
    if (!ask) return;

    const { routine, block, day } = ask;
    const weekday = day.getDay();
    /*
     * A routine that only ever runs on one weekday has nothing to distinguish
     * "every Tuesday" from "the whole routine" — so the widest answer is not
     * offered, and the middle one is quietly treated as it. An override
     * carving an exception out of the only day a rule applies to would be a
     * rule with nothing left of it.
     */
    const wide = scope === "routine" || routine.weekday !== null;

    try {
      if (ask.verb === "move") {
        const time_of_day = ask.time_of_day!;
        if (scope === "once") return; // the lock from the drag already said it

        let next = routine;
        let overrides = routineOverrides;
        if (wide) {
          next = await db.updateRoutine(routine.id, { time_of_day });
          // A time restated for every day it runs on has nothing left to make
          // an exception to, and a surviving Tuesday rule would be the one day
          // that visibly refused the change.
          await db.clearRoutineOverrides(routine.id);
          overrides = overrides.filter((o) => o.routine_id !== routine.id);
        } else {
          const saved = await db.setRoutineOverride({
            user_id: userId,
            routine_id: routine.id,
            weekday,
            time_of_day,
          });
          overrides = [
            ...overrides.filter(
              (o) => !(o.routine_id === routine.id && o.weekday === weekday),
            ),
            saved,
          ];
        }

        // Unlocked first, then rewritten. The lock was the drag saying "a
        // person put this here"; now the rule itself says six o'clock, so this
        // block is an exception to nothing, and leaving it pinned would freeze
        // one Tuesday against every later edit of the routine it agrees with.
        await db.unlockBlock(block.id);
        await rewrite(next, overrides, routineSkips);
        await refresh();
        toast(
          wide
            ? `${routine.title} now at ${clockOf(hhmmToDate(time_of_day))}`
            : `${routine.title} moved on ${WEEKDAYS[weekday]}s`,
          "success",
        );
        return;
      }

      /* Removal. */
      if (scope === "routine" || (scope === "weekday" && routine.weekday !== null)) {
        setPlanBlocks((prev) => prev.filter((b) => b.routine_id !== routine.id));
        await db.deleteRoutine(routine.id);
        await refresh();
        toast(`${routine.title} removed`, "success");
        return;
      }

      if (scope === "weekday") {
        const saved = await db.setRoutineOverride({
          user_id: userId,
          routine_id: routine.id,
          weekday,
          time_of_day: null,
          skipped: true,
        });
        await rewrite(
          routine,
          [
            ...routineOverrides.filter(
              (o) => !(o.routine_id === routine.id && o.weekday === weekday),
            ),
            saved,
          ],
          routineSkips,
        );
        await refresh();
        toast(`No ${routine.title} on ${WEEKDAYS[weekday]}s`, "success");
        return;
      }

      /*
       * Just this once. The block goes, and a skip remembers why — without it
       * the next Replan would put it straight back, which reads as the app
       * disagreeing with you.
       */
      const on_date = `${day.getFullYear()}-${`${day.getMonth() + 1}`.padStart(2, "0")}-${`${day.getDate()}`.padStart(2, "0")}`;
      setPlanBlocks((prev) => prev.filter((b) => b.id !== block.id));
      await db.addRoutineSkip({ user_id: userId, routine_id: routine.id, on_date });
      await db.deleteBlock(block.id);
      await refresh();
    } catch (e) {
      toast(errorText(e, "Could not change that routine"), "error");
      await refresh();
    }
  }

  /* --- Drag ---------------------------------------------------------------*/

  type DragSubject =
    | { kind: "task"; task: Task; minutes: number }
    | { kind: "block"; block: PlanBlock; title: string; minutes: number };

  const [dragging, setDragging] = useState<DragSubject | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  /*
   * Pointer first, rectangles as a fallback.
   *
   * A column is one target now rather than a ladder of seams, so the old
   * nesting problem is gone — but `pointerWithin` is still the right question
   * to ask, because the answer has to be the column the cursor is *in* for the
   * height of that cursor to mean a time. The fallback covers a keyboard drag,
   * where there is no cursor to ask about.
   */
  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    return hits.length ? hits : rectIntersection(args);
  };

  function titleOf(block: PlanBlock): string {
    if (block.google_event_id) return block.title ?? "Calendar";
    if (block.task_id) return taskById.get(block.task_id)?.title ?? "Task";
    return routineById.get(block.routine_id ?? "")?.title ?? "Routine";
  }

  function onDragStart(e: DragStartEvent) {
    setOpenId(null);
    const id = String(e.active.id);
    if (id.startsWith("task:")) {
      const u = outstanding.find((o) => o.task_id === id.slice(5));
      if (u) setDragging({ kind: "task", task: u.task, minutes: sitting(u.minutes) });
      return;
    }
    const block = planBlocks.find((b) => b.id === id.slice("block:".length));
    if (!block) return;
    setDragging({
      kind: "block",
      block,
      title: titleOf(block),
      minutes: blockMinutes(block),
    });
  }

  async function onDragEnd(e: DragEndEvent) {
    const subject = dragging;
    setDragging(null);
    const over = e.over?.id;
    if (!subject || typeof over !== "string") return;

    /*
     * A dragged thing that is part of the selection brings the selection with
     * it. Anything outside the selection is just itself, and leaves the
     * selection alone rather than silently clearing it.
     */
    const activeId =
      subject.kind === "task" ? `task:${subject.task.id}` : `block:${subject.block.id}`;
    const group = selection.count > 1 && selection.has(activeId);

    /* Off the board, into the rail. The only way to remove anything. */
    if (over === "unplanned") {
      if (group) {
        await unplanMany();
        return;
      }
      if (subject.kind === "task") return;
      await clear(subject.block);
      return;
    }

    if (!over.startsWith("day:")) return;
    const index = Number(over.slice(4));
    const day = days[index];
    if (!day) return;

    /*
     * Where on the bar you let go is when it happens.
     *
     * The height of the cursor inside the column is a time, read off the same
     * axis the blocks are drawn against — which is the whole reason for drawing
     * them to scale. Bottom-up, so the arithmetic measures from the foot.
     */
    const track = tracks.current.get(index);
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (!rect.height) return;
    const pointerY = pointerYOf(e.activatorEvent) + e.delta.y;
    const fromFoot = (rect.bottom - pointerY) / rect.height;
    // Clamped to the axis. A keyboard drag has no pointer to read, and an
    // unclamped fraction would put the block at some hour of the following
    // week rather than declining to guess.
    const cursorMin = Math.min(
      GRID_START_MIN + span,
      Math.max(GRID_START_MIN, GRID_START_MIN + fromFoot * span),
    );

    // Nothing may be planned into an hour that has gone. On today that floor
    // is now; on any later day it is the foot of the axis.
    const today = isSameDay(day, new Date());
    const floorMin = today
      ? Math.max(GRID_START_MIN, minutesFrom(day, new Date(snapUp(Date.now()))))
      : GRID_START_MIN;

    if (group) {
      await dropGroup(subject, day, cursorMin, floorMin);
      return;
    }

    const held = subject.kind === "task" ? null : subject.block.id;
    const { startMin, shifts } = insertAt({
      day,
      blocks: blocksByDay[index],
      cursorMin,
      minutes: subject.minutes,
      heldId: held,
      floorMin,
    });
    const start = instantOf(day, startMin);

    if (start.getTime() + subject.minutes * 60_000 <= Date.now()) {
      toast("That hour has already gone", "info");
      return;
    }

    try {
      // Room first, then the thing that needed it — in that order on screen so
      // the new block never appears sitting on top of an old one, even for the
      // single frame between two setStates.
      await applyShifts(day, shifts);

      if (subject.kind === "task") {
        // Same reasoning as commitMove: the card appears where it was dropped
        // and the insert catches up. The placeholder carries a temporary id
        // only until the real row comes back.
        const starts_at = start.toISOString();
        const ends_at = new Date(
          start.getTime() + subject.minutes * 60_000,
        ).toISOString();
        const temp = `pending-${subject.task.id}-${starts_at}`;
        const previous = planBlocks;
        setPlanBlocks((prev) =>
          inOrder([
            ...prev,
            {
              id: temp,
              user_id: userId,
              task_id: subject.task.id,
              routine_id: null,
              google_event_id: null,
              google_series_id: null,
              title: null,
              starts_at,
              ends_at,
              locked: true,
              dismissed: false,
              created_at: starts_at,
              updated_at: starts_at,
            },
          ]),
        );
        try {
          const saved = await db.createTaskBlock({
            user_id: userId,
            task_id: subject.task.id,
            starts_at,
            ends_at,
          });
          setPlanBlocks((prev) =>
            inOrder(prev.map((b) => (b.id === temp ? saved : b))),
          );
        } catch (err) {
          setPlanBlocks(previous);
          toast(errorText(err, "Could not place that"), "error");
        }
        return;
      }
      // A lecture dragged back out of the rail is un-dismissed by the same
      // gesture that placed it — commitMove has already cleared the flag on
      // screen. Two steps would mean restoring it and then being told it is
      // somewhere you did not put it.
      const restoring = subject.block.dismissed;
      await commitMove(subject.block, start, subject.minutes);
      if (restoring) await db.setDismissed(subject.block.id, false);
      askScope(subject.block, start);
    } catch (err) {
      toast(errorText(err, "Could not place that"), "error");
    }
  }

  /**
   * Dropping several things at once.
   *
   * Two gestures, told apart by what you grabbed, because the two selections
   * mean different things.
   *
   * Grab a *block* and the whole selection of blocks travels by one time
   * delta: the thing under the cursor lands where you dropped it and every
   * other selected block moves by exactly as much, so the gaps between them —
   * and the days between them — survive intact. That is what "keep their
   * relative spacing" has to mean once a selection can span Tuesday and
   * Friday.
   *
   * Grab a *rail item* and the selected rail items stack back to back from the
   * drop point, in the order the rail lists them. There is no spacing to
   * preserve — none of them has ever had a time — and an evening of work
   * planned as one run is what dragging four unplanned things onto Thursday
   * was asking for.
   *
   * Neither cascades. A single drop pushes what it lands on out of the way,
   * which is a legible rearrangement of one day; six blocks each pushing their
   * own neighbours is not something anyone could predict before letting go, so
   * a group lands where it lands and is allowed to overlap. The chart draws
   * the clash side by side and you can see exactly what happened.
   */
  async function dropGroup(
    subject: DragSubject,
    day: Date,
    cursorMin: number,
    floorMin: number,
  ) {
    const startMin = Math.max(floorMin, snapToSlot(cursorMin));
    const start = instantOf(day, startMin);

    if (subject.kind === "block") {
      const delta = start.getTime() - Date.parse(subject.block.starts_at);
      const moved = chosenBlocks.map((b) => {
        const s = new Date(Date.parse(b.starts_at) + delta);
        return {
          id: b.id,
          starts_at: s.toISOString(),
          ends_at: new Date(s.getTime() + blockMinutes(b) * 60_000).toISOString(),
        };
      });

      // All or nothing against the clock. Moving four blocks and quietly
      // dropping the one that would land this morning is a worse outcome than
      // refusing: you would not find out which one until you went looking.
      const stale = moved.filter((m) => Date.parse(m.ends_at) <= Date.now()).length;
      if (stale) {
        toast(
          stale === moved.length
            ? "That hour has already gone"
            : `That would put ${stale} of them in an hour that has gone`,
          "info",
        );
        return;
      }

      const byId = new Map(moved.map((m) => [m.id, m]));
      const previous = planBlocks;
      setPlanBlocks((prev) =>
        inOrder(
          prev.map((b) => {
            const m = byId.get(b.id);
            return m ? { ...b, starts_at: m.starts_at, ends_at: m.ends_at, locked: true } : b;
          }),
        ),
      );
      try {
        await Promise.all(
          moved.map((m) => db.moveBlock(m.id, m.starts_at, m.ends_at)),
        );
      } catch (e) {
        setPlanBlocks(previous);
        toast(errorText(e, "Could not move those"), "error");
      }
      return;
    }

    /* A run of unplanned work, back to back from where you let go. */
    const queue = outstanding.filter((u) => selection.has(`task:${u.task_id}`));
    if (!queue.length) return;

    let cursor = start.getTime();
    const placing = queue.map((u) => {
      const minutes = sitting(u.minutes);
      const starts_at = new Date(cursor).toISOString();
      cursor += minutes * 60_000;
      return { task_id: u.task_id, starts_at, ends_at: new Date(cursor).toISOString() };
    });

    if (Date.parse(placing[0].starts_at) + 60_000 <= Date.now()) {
      toast("That hour has already gone", "info");
      return;
    }

    const previous = planBlocks;
    selection.clear();
    setPlanBlocks((prev) =>
      inOrder([
        ...prev,
        ...placing.map((pl) => ({
          id: `pending-${pl.task_id}-${pl.starts_at}`,
          user_id: userId,
          task_id: pl.task_id,
          routine_id: null,
          google_event_id: null,
          google_series_id: null,
          title: null,
          starts_at: pl.starts_at,
          ends_at: pl.ends_at,
          locked: true,
          dismissed: false,
          created_at: pl.starts_at,
          updated_at: pl.starts_at,
        })),
      ]),
    );
    try {
      await Promise.all(
        placing.map((pl) =>
          db.createTaskBlock({
            user_id: userId,
            task_id: pl.task_id,
            starts_at: pl.starts_at,
            ends_at: pl.ends_at,
          }),
        ),
      );
      await refresh();
      toast(`${placing.length} things given hours`, "success");
    } catch (e) {
      setPlanBlocks(previous);
      toast(errorText(e, "Could not place those"), "error");
    }
  }

  /* --- The screen ---------------------------------------------------------*/

  /*
   * What the pickers show for a selection: the shared value, or nothing.
   *
   * Showing the first task's estimate for a mixed selection would be a control
   * that lies about four of the five things it is pointed at, and the first
   * thing anybody does with a picker is read it before touching it.
   */
  const sharedClass =
    chosenTasks.length &&
    chosenTasks.every((t) => t.class_id === chosenTasks[0].class_id)
      ? chosenTasks[0].class_id ?? ""
      : "";
  const sharedEstimate =
    chosenTasks.length &&
    chosenTasks.every((t) => t.estimate_minutes === chosenTasks[0].estimate_minutes)
      ? chosenTasks[0].estimate_minutes
      : null;

  return (
    <div className="stack">
      <div className="page-head week-head">
        <div>
          <h1>Week</h1>
          <p className="muted small">
            {plannedMinutes
              ? `${formatMinutes(plannedMinutes)} of work planned across the next seven days`
              : "No plan yet. Press Plan the week and the deadlines below get hours."}
          </p>
        </div>
        <div className="row week-actions">
          {/* Secondary, and only offered when there is a calendar to be out of
              step with. A reset button on a feature you have not connected is
              a button that can only disappoint. */}
          {calendarGranted !== false && (
            <button
              className="btn-quiet"
              onClick={() => void resync()}
              disabled={resyncing}
              title="Discard local moves and skips, and take Google's times again"
            >
              {resyncing ? "Syncing…" : "Resync calendar"}
            </button>
          )}
          <button onClick={() => void regenerate()} disabled={generating}>
            {generating
              ? "Planning…"
              : onBoard.some((b) => b.task_id)
                ? "Replan"
                : "Plan the week"}
          </button>
        </div>
      </div>

      {/* Said once, quietly, and only when it is true. The planner works
          without the calendar; it just assumes more of the day is free than
          it really is, and someone should know that is the assumption.

          No button. Granting the permission is not this screen's job — the
          Classes tab raises it as part of the one reconnect prompt the app
          already has. */}
      {calendarGranted === false ? (
        <p className="muted small notice">
          Planning without your calendar, so every hour you have set aside counts
          as free.
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={(e) => void onDragEnd(e)}
        onDragCancel={() => setDragging(null)}
      >
        {/*
          The chart. Seven bars and the axis they are measured against.

          `--span` is how many minutes of day the tallest column needs and
          `--base` is the fifteen the axis nominally holds; the track's height
          is the first over the second, so an ordinary week fits the window
          exactly and only a week that has been pushed past bedtime scrolls.
          Every column takes the same two numbers, which is what makes Thursday
          and Sunday comparable at a glance.
        */}
        <div
          className="week-scroll"
          style={
            {
              "--span": span,
              "--base": GRID_MINUTES,
            } as React.CSSProperties
          }
        >
          <div className="week-grid">
            <div className="week-axis">
              <div className="axis-head" aria-hidden="true" />
              <div className="axis-track">
                {marks.map((m) => (
                  <span
                    key={m.min}
                    className="axis-mark"
                    style={{ bottom: `${((m.min - GRID_START_MIN) / span) * 100}%` }}
                  >
                    {m.label ? clockOfMinutes(m.min) : ""}
                  </span>
                ))}
              </div>
            </div>

            {days.map((day, i) => (
              <DayColumn
                key={day.getTime()}
                day={day}
                index={i}
                marks={marks}
                span={span}
                register={(el) => {
                  if (el) tracks.current.set(i, el);
                  else tracks.current.delete(i);
                }}
              >
                {laid[i].map((p) => (
                  <BlockBar
                    key={p.item.id}
                    placed={p}
                    span={span}
                    hue={hueOf(p.item)}
                    title={titleOf(p.item)}
                    open={openId === p.item.id}
                    onToggle={() =>
                      setOpenId((cur) => (cur === p.item.id ? null : p.item.id))
                    }
                    selected={selection.has(`block:${p.item.id}`)}
                    onSelect={(e) => selection.select(`block:${p.item.id}`, e)}
                    /* Anchored away from the edge of the window. A panel wider
                       than its column has to lean somewhere, and on Saturday
                       the only direction with room is left. */
                    flip={i >= DAYS - 2}
                    /* And upward or downward. A panel hanging off a block near
                       the head of the column would open straight out of the
                       top of the scroller. */
                    vflip={
                      (p.startMin - GRID_START_MIN) / span > 0.55
                    }
                    task={p.item.task_id ? taskById.get(p.item.task_id) ?? null : null}
                    routine={
                      p.item.routine_id
                        ? routineById.get(p.item.routine_id) ?? null
                        : null
                    }
                    cls={classById}
                    classes={classes}
                    eventClass={linkedClassOf(p.item)}
                    eventSession={sessionOf(p.item)}
                    eventSuggestion={classForEvent(p.item.title, classes)}
                    onLinkSeries={(id) => void linkSeries(p.item, id)}
                    onRetime={(t) => void retime(p.item, t)}
                    onResize={(t) => void resize(p.item, t)}
                    onOpenClass={onOpenClass}
                  />
                ))}
              </DayColumn>
            ))}
          </div>
        </div>

        {/*
          The rail exists because a planner that silently compresses the week to
          make it look achievable is worse than none. These are hours the plan
          could not find a home for; they have not gone anywhere.

          It is also where things come back to, and now the only way they leave
          the grid: drag a block down here and it is off the board. An hour that
          passed without the work being done stops counting as planned and the
          task reappears here on its own — nothing is deleted and nothing is
          quietly forgiven.
        */}
        <UnplannedRail
          outstanding={outstanding}
          skipped={skipped}
          classById={classById}
          missed={missed}
          selection={selection}
        />

        <DragOverlay>
          {dragging && (
            <div className="card overlay">
              {selection.count > 1 &&
              selection.has(
                dragging.kind === "task"
                  ? `task:${dragging.task.id}`
                  : `block:${dragging.block.id}`,
              )
                ? `${selection.count} selected`
                : dragging.kind === "task"
                  ? dragging.task.title
                  : dragging.title}
            </div>
          )}
        </DragOverlay>

        {/*
          Two removals, side by side, because they are two different
          sentences. Unplan takes the hours back and leaves the work; Delete
          decides the work is not happening. One button meaning either would
          be pressed for the first and do the second.
        */}
        <SelectionBar count={selection.count} onClear={selection.clear}>
          <button className="btn-quiet" onClick={() => void unplanMany()}>
            Unplan
          </button>
          <button className="btn-quiet" onClick={() => void markDone()}>
            Mark done
          </button>

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

          <button className="btn-quiet danger" onClick={deleteMany}>
            Delete
          </button>
        </SelectionBar>
      </DndContext>

      {asking && (
        <ScopeDialog
          title={
            asking.verb === "move"
              ? `${asking.routine.title} moved to ${clockOf(hhmmToDate(asking.time_of_day!))}. Apply to…`
              : `Remove ${asking.routine.title} from…`
          }
          weekday={WEEKDAYS[asking.day.getDay()]}
          everyDay={asking.routine.weekday === null}
          onceLabel={
            isSameDay(asking.day, new Date())
              ? "Just today"
              : `Just this ${WEEKDAYS[asking.day.getDay()]}`
          }
          routineLabel={asking.verb === "move" ? "Every day" : "The whole routine"}
          danger={asking.verb === "remove"}
          onChoose={(scope) => void applyScope(scope)}
          onCancel={() => setAsking(null)}
        />
      )}

      <RoutinesPanel store={store} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Blocks in clock order.
 *
 * The layout sorts its own copy, so this no longer decides what the grid
 * looks like — but the array is still read in order everywhere else, and an
 * optimistic edit that left it shuffled would make the next diff harder to
 * reason about than the sort costs.
 */
function inOrder(blocks: PlanBlock[]): PlanBlock[] {
  return [...blocks].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
}

/**
 * How long a task claims when it is dragged onto a day.
 *
 * The whole job. This used to book one ninety-minute sitting and leave the
 * remainder in the rail, which is the same half-a-task the planner used to
 * produce — and worse here, because you dropped the essay on Thursday and the
 * app decided only part of it was going there.
 */
function sitting(minutes: number): number {
  return Math.max(SLOT_MINUTES, Math.round(minutes));
}

/** Where the pointer is, from the event that started the drag. */
function pointerYOf(e: Event | null): number {
  if (e && "clientY" in e) return (e as PointerEvent).clientY;
  return 0;
}

/**
 * One day: a header, and a track things are drawn on.
 *
 * The track is the drop target, and the only one in the column. The old grid
 * had a droppable in every seam between every pair of cards — a ladder of
 * targets standing in for the continuous thing they were approximating — and
 * with the day drawn to scale the continuous thing is right there. Where you
 * let go is the time.
 */
function DayColumn({
  day,
  index,
  marks,
  span,
  register,
  children,
}: {
  day: Date;
  index: number;
  marks: { min: number; label: boolean }[];
  span: number;
  /** Hands the track element up, so a drop can measure it where it now is. */
  register: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  const today = isSameDay(day, new Date());
  const { setNodeRef, isOver } = useDroppable({ id: `day:${index}` });

  return (
    <section className={`day-col${today ? " today" : ""}`}>
      <h2 className="day-head">
        <span>{day.toLocaleDateString(undefined, { weekday: "short" })}</span>
        <span className="count">{day.getDate()}</span>
      </h2>
      <div
        ref={(el) => {
          setNodeRef(el);
          register(el);
        }}
        className={`day-track${isOver ? " over" : ""}`}
      >
        {/* The rules, repeated per column rather than laid across the grid.
            A single set of lines behind seven columns cannot pass *behind* a
            block and in front of the gaps beside it, which is the one thing
            they have to do. */}
        {marks.map((m) => (
          <span
            key={m.min}
            className="hour-rule"
            aria-hidden="true"
            style={{ bottom: `${((m.min - GRID_START_MIN) / span) * 100}%` }}
          />
        ))}
        {children}
      </div>
    </section>
  );
}

/**
 * One block on the bar: work, a routine, or a lecture.
 *
 * Closed, it is a name and a colour and nothing else. That is the whole design
 * of it — seven columns of cards each carrying a time range, a class, a length
 * and a Remove link was a wall of text where a chart should be, and none of
 * those four things is what you are looking for when you glance at a Thursday.
 *
 * Open, it says everything, over the top of the column. Over rather than
 * inside: a card that grew would push its neighbours up the axis and the chart
 * would briefly be wrong, which is a strange thing for a chart to do because
 * somebody looked at it.
 *
 * There is no Remove. Dragging it into the Unplanned rail is how things leave
 * the board, and it is the same gesture reversed that brings them back.
 */
function BlockBar({
  placed,
  span,
  hue,
  title,
  open,
  flip,
  vflip,
  onToggle,
  selected,
  onSelect,
  task,
  routine,
  cls,
  classes,
  eventClass,
  eventSession,
  eventSuggestion,
  onLinkSeries,
  onRetime,
  onResize,
  onOpenClass,
}: {
  placed: Placed<PlanBlock>;
  span: number;
  hue: string;
  title: string;
  open: boolean;
  flip: boolean;
  vflip: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (e: SelectModifiers) => void;
  task: Task | null;
  routine: Routine | null;
  cls: Map<string, Class>;
  /** Every class, for the picker on a lecture. Empty for anything else. */
  classes: Class[];
  /** The class this lecture was confirmed to be, or null if never answered. */
  eventClass: Class | null;
  /** What is on in it, when the class has a timetable covering that day. */
  eventSession: ClassSession | null;
  /** A title match, offered as a suggestion and never applied on its own. */
  eventSuggestion: Class | null;
  /** "" unlinks. Remembered against the whole recurring series. */
  onLinkSeries: (classId: string) => void;
  onRetime: (hhmm: string) => void;
  onResize: (hhmm: string) => void;
  onOpenClass: (id: string) => void;
}) {
  const block = placed.item;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block:${block.id}`,
  });
  const box = geometry(placed, span);
  const minutes = placed.endMin - placed.startMin;
  const event = Boolean(block.google_event_id);
  const klass = task?.class_id ? cls.get(task.class_id) : undefined;
  const past = Date.parse(block.ends_at) <= Date.now();

  const pop = useRef<HTMLDivElement | null>(null);

  /*
   * Click anywhere else and it closes.
   *
   * Only mounted while something is open, so the common case — reading the
   * chart — costs no listener at all. `pointerdown` rather than `click`, so a
   * drag starting elsewhere closes the panel as it begins rather than after it
   * lands.
   */
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node)) onToggle();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggle();
    };
    // Deferred a tick: the pointerdown that opened this is still on its way up.
    const t = setTimeout(() => {
      document.addEventListener("pointerdown", away);
      document.addEventListener("keydown", esc);
    });
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, onToggle]);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        if (isSelectClick(e)) return;
        onToggle();
      }}
      /*
       * A modified click selects, and stops being anything else — no panel,
       * no drag. Caught on the way down so dnd-kit's own listener never sees
       * it, and `preventDefault` so a shift-click does not also select the
       * text across half the column.
       */
      onPointerDownCapture={(e) => {
        if (!isSelectClick(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(e);
      }}
      aria-selected={selected}
      className={`bar ${hue}${selected ? " selected" : ""}${isDragging ? " dragging" : ""}${
        routine ? " routine" : ""
      }${event ? " event" : ""}${block.locked ? " locked" : ""}${
        past ? " past" : ""
      }${minutes < SLIVER_MINUTES ? " sliver" : ""}${open ? " open" : ""}`}
      style={{
        bottom: `${box.bottom * 100}%`,
        height: `${box.height * 100}%`,
        left: `${box.left * 100}%`,
        width: `${box.width * 100}%`,
      }}
      title={`${title} · ${clockOf(block.starts_at)}–${clockOf(block.ends_at)}`}
    >
      {/* The name, and only the name. A block too short to hold one is left as
          a bare stripe of colour rather than given an ellipsis to wear — three
          dots in a class colour say less than the colour does on its own. */}
      <span className="bar-name">{title}</span>

      {open && (
        <div
          ref={pop}
          className={`bar-pop${flip ? " flip" : ""}${vflip ? " vflip" : ""}`}
          /* The panel is not a handle and not a way to open something else.
             Both gestures are already spoken for by the block underneath it. */
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="pop-title">{title}</p>

          {/*
            The time is the control. Both ends of it, because the end is how
            long the work takes and that is the number a plan is most often
            wrong about.
          */}
          <div className="row pop-time">
            <TimePicker
              value={hhmmOf(
                new Date(block.starts_at).getHours() * 60 +
                  new Date(block.starts_at).getMinutes(),
              )}
              compact
              display={clockOf(block.starts_at)}
              onChange={onRetime}
            />
            <span className="muted" aria-hidden="true">
              –
            </span>
            <TimePicker
              value={hhmmOf(
                new Date(block.ends_at).getHours() * 60 +
                  new Date(block.ends_at).getMinutes(),
              )}
              compact
              display={clockOf(block.ends_at)}
              onChange={onResize}
            />
            <span className="muted small pop-length">{formatMinutes(minutes)}</span>
          </div>

          {/*
            What this lecture is, and what is on in it — phase 10.

            A calendar block used to say "Calendar" and stop there, which is
            all Google gives us: a title string and two times. Told once which
            class the series is, the app can put the professor's own topic for
            that day on the block you are looking at on the Wednesday morning.

            The link is asked for, never assumed. The suggestion below is the
            same title match that already picks the bar's colour, and it stays
            a suggestion: a lecture silently attached to the wrong class would
            show the wrong topic with nothing on screen to explain why.
          */}
          {event && (
            <div className="pop-lecture small">
              {eventSession ? (
                <>
                  <p className="pop-session-topic">{eventSession.topic}</p>
                  {eventSession.details && (
                    <p className="muted">{eventSession.details}</p>
                  )}
                  {eventSession.is_assessment && (
                    <span className="tag">Assessment</span>
                  )}
                </>
              ) : eventClass ? (
                /* Linked, and the timetable simply has nothing for this day —
                   a reading week, or a term only half uploaded. Said plainly,
                   because silence here reads as the link not having worked. */
                <p className="muted">
                  No topic for this day in {eventClass.name}&rsquo;s timetable.
                </p>
              ) : null}

              <div className="row pop-link">
                <span className="muted">Class</span>
                <ClassPicker
                  classes={classes}
                  value={eventClass?.id ?? ""}
                  onChange={onLinkSeries}
                />
              </div>
              {!eventClass && eventSuggestion && (
                <button
                  className="link"
                  onClick={() => onLinkSeries(eventSuggestion.id)}
                >
                  This is {eventSuggestion.name}
                </button>
              )}
              {/* Said once, because the scope of the answer is the surprising
                  part: you are not labelling Wednesday, you are labelling
                  every Wednesday. */}
              <p className="muted">Remembered for every lecture in this series.</p>
            </div>
          )}

          <div className="pop-meta small">
            {event ? (
              <span className="muted">
                {eventClass ? eventClass.name : "Calendar"}
              </span>
            ) : routine ? (
              <span className="muted">Repeats</span>
            ) : klass ? (
              <button className="link" onClick={() => onOpenClass(klass.id)}>
                {klass.name}
              </button>
            ) : null}
            {task?.due_at && (
              <span className="muted">Due {formatDue(task.due_at)}</span>
            )}
          </div>

          {/* Said once, where the button used to be, because a card with
              nothing to press on it should say what the gesture is. */}
          <p className="muted small pop-hint">Drag to Unplanned to take it off.</p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function UnplannedRail({
  outstanding,
  skipped,
  classById,
  missed,
  selection,
}: {
  outstanding: {
    task_id: string;
    minutes: number;
    guessed: boolean;
    missed: boolean;
    task: Task;
  }[];
  skipped: PlanBlock[];
  classById: Map<string, Class>;
  missed: number;
  selection: Selection;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "unplanned" });
  const total = outstanding.reduce((s, u) => s + u.minutes, 0);
  const empty = outstanding.length === 0 && skipped.length === 0;

  return (
    <section
      ref={setNodeRef}
      className={`panel unplanned-rail${isOver ? " over" : ""}`}
    >
      <div className="panel-head">
        <h2>Unplanned</h2>
        <span className="muted small">
          {outstanding.length
            ? `${formatMinutes(total)} with no hour against it`
            : "Everything on the board has time set aside."}
        </span>
      </div>

      {/* The honest sentence about work that did not happen. An hour that went
          by without it stops counting, which is why the task is back here — it
          was neither deleted nor quietly marked as handled. */}
      {missed > 0 && (
        <p className="muted small notice">
          {missed === 1 ? "One thing" : `${missed} things`} had time set aside
          that has since passed. Those hours are back here, and Replan will find
          them new ones.
        </p>
      )}

      {empty ? (
        <p className="muted small">Drag anything off the grid and it lands here.</p>
      ) : (
        <ul className="list unplaced">
          {outstanding.map((u) => {
            const cls = u.task.class_id ? classById.get(u.task.class_id) : undefined;
            return (
              <RailItem
                key={u.task_id}
                id={`task:${u.task_id}`}
                hue={cls ? `hue-${cls.color}` : "hue-none"}
                title={u.task.title}
                selected={selection.has(`task:${u.task_id}`)}
                onSelect={(e) => selection.select(`task:${u.task_id}`, e)}
              >
                {u.missed && <span className="tag">Missed</span>}
                <span className={u.guessed ? "muted small guessed" : "muted small"}>
                  {formatMinutes(u.minutes)}
                </span>
                <span className="muted small">{formatDue(u.task.due_at)}</span>
              </RailItem>
            );
          })}

          {/* Lectures you dropped. Kept rather than deleted, because the row
              mirrors Google and a delete would be undone on the next refresh —
              and because "actually, I will go" is a normal Tuesday. */}
          {skipped.map((b) => (
            <RailItem
              key={b.id}
              id={`block:${b.id}`}
              hue="hue-none"
              title={b.title ?? "Calendar"}
              selected={selection.has(`block:${b.id}`)}
              onSelect={(e) => selection.select(`block:${b.id}`, e)}
            >
              <span className="tag">Skipping</span>
              <span className="muted small">
                {new Date(b.starts_at).toLocaleDateString(undefined, {
                  weekday: "short",
                })}{" "}
                {clockOf(b.starts_at)}
              </span>
            </RailItem>
          ))}
        </ul>
      )}
    </section>
  );
}

function RailItem({
  id,
  hue,
  title,
  selected,
  onSelect,
  children,
}: {
  id: string;
  hue: string;
  title: string;
  selected: boolean;
  onSelect: (e: SelectModifiers) => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  return (
    <li
      ref={setNodeRef}
      className={`${hue} rail-item${isDragging ? " dragging" : ""}${
        selected ? " selected" : ""
      }`}
      {...listeners}
      {...attributes}
      onPointerDownCapture={(e) => {
        if (!isSelectClick(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(e);
      }}
      aria-selected={selected}
    >
      <span className="dot" />
      <span className="grow ellipsis">{title}</span>
      {children}
    </li>
  );
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "18:00" as a Date on an arbitrary day, purely so clockOf can format it. */
function hhmmToDate(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

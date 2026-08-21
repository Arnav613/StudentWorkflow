import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import * as db from "../lib/db";
import { getCalendar } from "../lib/api";
import { errorText, toast, undoable } from "../lib/toast";
import { formatDue, slotPosition } from "../lib/board";
import {
  DEFAULT_ESTIMATE_MINUTES,
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
  logicalDayOf,
  planDays,
  autoplan,
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
import PlannerChat from "../components/PlannerChat";
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

  /* --- Hours that went by without the work ---------------------------------- */

  /**
   * An hour set aside for work that is still not done, once that hour is over,
   * is not a plan any more — and it is not history worth drawing either.
   *
   * So it is deleted rather than dimmed. The task goes back to the Unplanned
   * rail carrying exactly what it still needs, indistinguishable from work
   * that was never scheduled, and the next Autoplan finds it a new hour. The
   * previous behaviour kept the block on the grid greyed out *and* listed the
   * task as unplanned, which is the same evening claimed by two sections of
   * one screen: the board saying Tuesday eight to nine is spoken for, the rail
   * underneath saying that work has no hour against it.
   *
   * Only work, and only work that is unfinished. A lapsed lecture is a lecture
   * that happened, a routine block is a standing arrangement, and an hour
   * spent on something now marked done is a receipt — all three are things
   * that did occur, and the grid is right to keep showing them.
   *
   * Swept when the week loads and whenever the rows change, which is the same
   * cadence everything else on this screen reads the clock at. A block that
   * lapses while the tab sits open is caught by the next render that touches
   * it; nothing here polls, because a planner that rewrites your week on a
   * timer while you are looking at it is worse than one that is a few minutes
   * behind.
   */
  const sweeping = useRef(new Set<string>());
  useEffect(() => {
    const now = Date.now();
    const lapsed = planBlocks.filter(
      (b) =>
        b.task_id &&
        !sweeping.current.has(b.id) &&
        Date.parse(b.ends_at) <= now &&
        taskById.get(b.task_id)?.status !== "done",
    );
    if (!lapsed.length) return;

    const ids = lapsed.map((b) => b.id);
    for (const id of ids) sweeping.current.add(id);
    setPlanBlocks((prev) => prev.filter((b) => !ids.includes(b.id)));

    void (async () => {
      try {
        await db.deleteBlocks(ids);
      } catch {
        // The row is still there and the screen no longer shows it, which the
        // next load quietly puts right — this effect runs again and tries
        // again. Not worth a toast: nothing the person at the keyboard did
        // failed, and there is nothing for them to do about it.
        for (const id of ids) sweeping.current.delete(id);
      }
    })();
  }, [planBlocks, taskById, setPlanBlocks]);

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
    // The logical day, so a lecture that somehow runs past midnight is still
    // looked up against the evening it belongs to. See DAY_ROLLOVER_HOUR.
    const key = isoDate(logicalDayOf(block.starts_at));
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

  /*
   * What the chart draws.
   *
   * Dismissed lectures are out, as they always were. Work whose task is
   * finished is out too, and that is new: a block is an hour you have set
   * aside to do something, and once the something is done the hour is not a
   * plan any more, it is a receipt. Leaving them drawn meant marking eleven
   * readings done on the board and then looking at a week still solidly
   * booked with them — the screen contradicting the screen next to it.
   *
   * Hidden, and never deleted. The rows stay exactly where they are, so a task
   * dragged back out of Done comes back to the week with its hours intact and
   * nothing to re-plan. That is the difference between finishing something and
   * changing your mind about it, and it is not the app's to guess.
   */
  const onBoard = planBlocks.filter(
    (b) =>
      !b.dismissed &&
      !(b.task_id && taskById.get(b.task_id)?.status === "done"),
  );
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

  /**
   * Where the thing in your hand would land if you let go now.
   *
   * Dragging used to be a guess. The cursor carries a small card with a title
   * on it and the column lights up, but the actual answer — *which half hour*
   * — was arithmetic done at the moment it was already too late to change your
   * mind. The chart knows that answer on every move; this is it, drawn.
   *
   * It is the real answer and not an approximation of one: the same `insertAt`
   * the drop itself runs, so the seam it snaps to and the blocks it will push
   * later are the ones you are looking at before you commit.
   */
  const [preview, setPreview] = useState<Drop | null>(null);

  /**
   * The columns as drawn, which mid-drag is not quite the columns as stored.
   *
   * A drop pushes whatever it lands on later, and that is a rearrangement of
   * your evening — the kind of thing you want to see before agreeing to it,
   * not after. So the pending shifts are folded into the geometry while the
   * block is still in the air: the neighbours slide up, the ghost sits in the
   * hole they left, and letting go changes nothing that was on screen.
   *
   * The axis does not rescale to it. Re-reading `span` from a preview that was
   * computed against `span` is a loop, and a chart whose ruler moves while you
   * drag is not a chart you can aim at.
   */
  const shown = useMemo(() => {
    if (!preview?.shifts.length) return laid;
    const to = new Map(preview.shifts.map((s) => [s.block.id, s.startMin]));
    return laid.map((column) =>
      column.map((p) => {
        const at = to.get(p.item.id);
        return at === undefined
          ? p
          : { ...p, startMin: at, endMin: at + (p.endMin - p.startMin) };
      }),
    );
  }, [laid, preview]);

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

  /**
   * The unplanned work that is selected, as ids Autoplan can plan.
   *
   * Only rail *tasks* count. The selection is one set across the whole page,
   * so a block on the grid can be in it too — and a grid block is by
   * definition an hour that has already been found, which is not something
   * Autoplan has anything to offer. A dropped lecture sitting in the rail is
   * not work either. Both are passed over rather than refused, so a mixed
   * selection still plans the part of itself that is plannable.
   *
   * Empty means empty: no rail selection is the old behaviour, the whole rail.
   * Selecting narrows, it is not a precondition for pressing the button.
   */
  const chosenUnplanned = useMemo(() => {
    const ids = new Set<string>();
    for (const u of outstanding) {
      if (selection.has(`task:${u.task_id}`)) ids.add(u.task_id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.selected, outstanding]);

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

  /**
   * Find hours for the work that has none.
   *
   * `rows` is here for the same reason it always was, and it is not
   * decoration. The planner chat writes estimates and then asks for a plan in
   * the same callback; those writes land in the database and then in `store` —
   * on the next render, which is one render too late for a callback already
   * running. Every input this function reads out of state is therefore one it
   * can read *stale*, and stale here does not throw: it plans a perfectly
   * valid week, the one you were arguing about rather than the one you just
   * agreed to.
   *
   * What changed is what the press *does*. This used to be Replan: delete
   * every block the planner had made, generate the week again from scratch,
   * write the lot back. One press could rearrange sessions you had read and
   * half worked through, and the only thing standing in its way was `locked` —
   * a flag set as an invisible side effect of dragging.
   *
   * Autoplan only adds. The board as it stands is handed in as time already
   * spoken for, the gaps that are left are filled with work the rail says has
   * no hour against it, and nothing already on the grid is moved or deleted.
   * That is why it is safe to press at any moment, and why it now lives on the
   * rail beside the work it is offering to place rather than at the top of the
   * page beside the week it used to overwrite.
   *
   * `only` is the rail's selection, when there is one: the ids of the tasks to
   * find hours for, instead of everything the rail lists. Nothing else about
   * the run changes — same board, same free hours, same order — so pressing it
   * with three things selected plans exactly the three you would have got had
   * the other twelve not been there to plan first.
   */
  async function fillGaps(rows: Task[] = tasks, only?: Set<string>) {
    setGenerating(true);
    try {
      // A selection narrows what is offered an hour; it never widens it. The
      // board, the free windows and the medians are all still the whole
      // week's — planning three things well means knowing what the other
      // twelve are already sitting on.
      const offered = only ? rows.filter((t) => only.has(t.id)) : rows;
      // `from` is now, not planFrom: today's morning is over and nothing can
      // be scheduled into it. The columns still start at midnight so the week
      // reads as a week.
      const plan = autoplan({
        tasks: offered,
        // Everything on the board, of every kind — lectures, routines and
        // work alike. A dismissed lecture is excluded upstream, because it is
        // an hour you got back; so is an hour set aside for work that is now
        // finished, for the same reason.
        placed: onBoard,
        from: new Date(),
        days: DAYS,
        medians: rows === tasks ? medians : classMedians(rows),
      });

      if (!plan.blocks.length && !plan.unplaced.length) {
        toast("Everything already has an hour against it", "info");
        return;
      }

      await db.addPlanBlocks(userId, plan.blocks);
      await refresh();
      // Everything just planned has left the rail, so most of the selection
      // has gone with it. Clearing the remainder matches Unplan and Delete,
      // which also leave nothing highlighted behind them.
      if (only) selection.clear();

      const placed = plan.blocks.length;
      const lead = placed ? `Planned ${placed}. ` : "";
      if (plan.unplaced.length) {
        const beyond = plan.unplaced.filter((u) => u.reason === "deadline").length;
        toast(
          beyond
            ? `${lead}${beyond} thing${beyond === 1 ? "" : "s"} cannot fit before ${beyond === 1 ? "its" : "their"} deadline.`
            : `${lead}${plan.unplaced.length} thing${plan.unplaced.length === 1 ? "" : "s"} did not fit your free hours.`,
          "info",
        );
      } else {
        toast(
          placed === 1 ? "One thing planned" : `${placed} things planned`,
          "success",
        );
      }
    } catch (e) {
      toast(errorText(e, "Could not plan that"), "error");
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
   * Delete one task from the block that represents it.
   *
   * The distinction Unplan and Delete draw for a selection, drawn again for
   * one: dragging a block to the rail says "not this hour", and this says "not
   * at all". Both are needed here and neither can stand in for the other —
   * before this existed, a task could only be deleted from the board, which
   * meant leaving the screen you noticed it on and finding it again among
   * everything else you are taking.
   *
   * Five seconds of undo, no dialog, and the block goes at once. Same contract
   * as every other delete in the app.
   */
  function deleteTask(task: Task) {
    const previousTasks = tasks;
    const previousBlocks = planBlocks;
    setOpenId(null);
    undoable({
      message: `Deleted "${task.title}"`,
      apply: () => {
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
        // The database cascades plan_blocks.task_id itself, but not until the
        // grace period is up, and a block drawn against a deleted task is a
        // ghost for as long as it stands.
        setPlanBlocks((prev) => prev.filter((b) => b.task_id !== task.id));
      },
      commit: () => db.deleteTask(task.id),
      revert: () => {
        setTasks(previousTasks);
        setPlanBlocks(previousBlocks);
      },
      onError: () => toast("The task is still there", "info"),
    });
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

  /** A drag position, fully read: where it lands and what it displaces. */
  type Drop = {
    /** Which column. */
    index: number;
    day: Date;
    /** The raw cursor time, before snapping — `dropGroup` reads it again. */
    cursorMin: number;
    /** The earliest minute anything may start on that day. */
    floorMin: number;
    startMin: number;
    minutes: number;
    shifts: { block: PlanBlock; startMin: number }[];
  };

  const [dragging, setDragging] = useState<DragSubject | null>(null);

  /*
   * A mouse and a finger want opposite activation rules — the same split the
   * board makes, for the same reason.
   *
   * A mouse gets distance: a drag must not start on a click aimed at a
   * block's panel. A finger cannot get distance, because a touch that has
   * moved five pixels on a page that scrolls has already been taken by the
   * browser as a scroll and the drag dies with it. So the two gestures are
   * separated in time instead: hold briefly and the block lifts, move first
   * and the week scrolls under your finger as it always did.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
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

  /**
   * The whole reading of a drag position, in one place.
   *
   * `onDragMove` draws it and `onDragEnd` commits it, and the two have to
   * agree exactly — a preview that lands half an hour off the drop is worse
   * than no preview at all, because it is a promise the app then breaks.
   */
  function resolveDrop(
    subject: DragSubject,
    over: string | number | undefined,
    activatorEvent: Event | null,
    deltaY: number,
  ): Drop | null {
    if (typeof over !== "string" || !over.startsWith("day:")) return null;
    const index = Number(over.slice(4));
    const day = days[index];
    if (!day) return null;

    /*
     * Where on the bar you let go is when it happens.
     *
     * The height of the cursor inside the column is a time, read off the same
     * axis the blocks are drawn against — which is the whole reason for
     * drawing them to scale. Bottom-up, so the arithmetic measures from the
     * foot.
     */
    const track = tracks.current.get(index);
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (!rect.height) return null;
    const pointerY = pointerYOf(activatorEvent) + deltaY;
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
    const floorMin = isToday(day)
      ? Math.max(GRID_START_MIN, minutesFrom(day, new Date(snapUp(Date.now()))))
      : GRID_START_MIN;

    const activeId =
      subject.kind === "task"
        ? `task:${subject.task.id}`
        : `block:${subject.block.id}`;
    const group = selection.count > 1 && selection.has(activeId);

    /*
     * A group lands where it lands and pushes nothing: six blocks each
     * shoving their own neighbours is not something anyone could predict
     * before letting go. So its preview is the anchor alone, snapped.
     */
    if (group) {
      return {
        index,
        day,
        cursorMin,
        floorMin,
        startMin: Math.max(floorMin, snapToSlot(cursorMin)),
        minutes: subject.minutes,
        shifts: [],
      };
    }

    const { startMin, shifts } = insertAt({
      day,
      blocks: blocksByDay[index],
      cursorMin,
      minutes: subject.minutes,
      heldId: subject.kind === "task" ? null : subject.block.id,
      floorMin,
    });
    return {
      index,
      day,
      cursorMin,
      floorMin,
      startMin,
      minutes: subject.minutes,
      shifts,
    };
  }

  function onDragMove(e: DragMoveEvent) {
    if (!dragging) return;
    setPreview(resolveDrop(dragging, e.over?.id, e.activatorEvent, e.delta.y));
  }

  /** Which id the selection knows this subject by. */
  function idOf(subject: DragSubject): string {
    return subject.kind === "task"
      ? `task:${subject.task.id}`
      : `block:${subject.block.id}`;
  }

  /*
   * A lift the browser took back.
   *
   * A finger resting on a page the browser still thinks it might be asked to
   * scroll, magnify or open a menu from arrives as a cancel rather than an
   * end. Losing the drag there is right; losing the selection is not, because
   * to the person holding the phone nothing happened at all.
   */
  function onDragCancel(e: DragCancelEvent) {
    const subject = dragging;
    setDragging(null);
    setPreview(null);
    if (subject && stationaryTouch(e)) {
      selection.select(idOf(subject), TOUCH_TOGGLE);
    }
  }

  function onDragStart(e: DragStartEvent) {
    // The lift is the only thing that says the hold registered, and on a
    // phone the block is under a finger while it happens.
    if (String((e.activatorEvent as Event | null)?.type).startsWith("touch")) {
      navigator.vibrate?.(10);
    }
    setOpenId(null);
    setPreview(null);
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
    setPreview(null);
    if (!subject) return;

    /*
     * A lift that never travelled is not a move — it is the touchscreen's
     * ctrl-click.
     *
     * A finger has no modifier to hold, so the hold that picks a block up is
     * also the only gesture available for "this one". Which of the two it was
     * is answered by the finger at the end rather than at the start: move and
     * it is the move it looked like, let go where you started and the block
     * stays where it is and is selected instead. Asked before the drop is
     * read, because a block released in place is still over its own column,
     * and that would be a silent retime to the minute it already had.
     */
    if (stationaryTouch(e)) {
      selection.select(idOf(subject), TOUCH_TOGGLE);
      return;
    }

    const over = e.over?.id;
    if (typeof over !== "string") return;

    /*
     * A dragged thing that is part of the selection brings the selection with
     * it. Anything outside the selection is just itself, and leaves the
     * selection alone rather than silently clearing it.
     */
    const activeId = idOf(subject);
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

    // The same reading the preview was drawn from, so what you were shown is
    // what happens.
    const drop = resolveDrop(subject, over, e.activatorEvent, e.delta.y);
    if (!drop) return;
    const { day, startMin, shifts } = drop;

    if (group) {
      await dropGroup(subject, day, drop.cursorMin, drop.floorMin);
      return;
    }

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

  /* --- Writing something new straight onto the week ---------------------- */

  /**
   * A slot somebody clicked an empty part of, waiting for a name.
   *
   * The week used to be a place work arrived at and never a place it started,
   * which is exactly backwards from how a week is actually decided: half of
   * what goes into one is thought of while looking at the gap it would fill.
   * The old answer was to go to the board, add a task, come back, find it in
   * the rail and drag it to the hour you were already pointing at.
   */
  const [adding, setAdding] = useState<{ index: number; startMin: number } | null>(
    null,
  );

  /**
   * Where a click on empty track means, or nothing.
   *
   * The same arithmetic a drop runs — see `resolveDrop` — because they are the
   * same question asked with a different gesture, and two answers to it would
   * be two grids. Snapped to a slot, floored at now on today: an hour that has
   * gone is not somewhere to put work, and offering a form for it would only
   * be a refusal one keystroke later.
   */
  function openSlot(index: number, cursorMin: number) {
    const day = days[index];
    if (!day) return;
    const floorMin = isToday(day)
      ? Math.max(GRID_START_MIN, minutesFrom(day, new Date(snapUp(Date.now()))))
      : GRID_START_MIN;
    const startMin = Math.max(floorMin, snapToSlot(cursorMin));
    // Past the top of the axis there is no evening left to plan into.
    if (startMin >= GRID_START_MIN + span) return;
    setOpenId(null);
    setAdding({ index, startMin });
  }

  /**
   * Write it down, and give it the hour it was written into.
   *
   * Two rows, in this order and not the other: the task is the thing that
   * exists, the block is a decision about when to do it. A block written first
   * and orphaned by a failed task insert would be an hour on the chart
   * belonging to nothing at all.
   *
   * The block is locked, like every placement made by hand. Somebody chose
   * this hour while looking at the day around it; Autoplan works around it
   * rather than treating it as one of its own guesses to reshuffle.
   */
  async function addAt(
    index: number,
    startMin: number,
    input: { title: string; classId: string; estimate: number | null },
  ) {
    const day = days[index];
    const title = input.title.trim();
    if (!day || !title) return;

    const starts = instantOf(day, startMin);
    const minutes = sitting(input.estimate ?? DEFAULT_ESTIMATE_MINUTES);
    const ends = new Date(starts.getTime() + minutes * 60_000);

    setAdding(null);
    try {
      const task = await db.createTask({
        user_id: userId,
        title,
        class_id: input.classId || null,
        estimate_minutes: input.estimate,
        // It has an hour on the Week, which is not a place in a column. The
        // foot of Do is where it goes, for the reason board.slotPosition gives.
        position: slotPosition(tasks, "todo", null),
      });
      await db.createTaskBlock({
        user_id: userId,
        task_id: task.id,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
      });
      await refresh();
      toast(`"${title}" added at ${clockOf(starts.toISOString())}`, "success");
    } catch (e) {
      toast(errorText(e, "Could not add that"), "error");
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
              : "Nothing planned yet. Autoplan, at the foot of the Unplanned list, finds hours for it."}
          </p>
          {/* Said once, in small type, because it is a gesture rather than a
              feature: there is no button for it and there should not be, but
              nobody clicks empty space on the off chance. */}
          <p className="muted small">
            Click an empty hour to write something straight onto that day.
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
        onDragMove={onDragMove}
        onDragEnd={(e) => void onDragEnd(e)}
        onDragCancel={onDragCancel}
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
                /* Only the column being dropped into draws one, and only for
                   as long as something is in the air over it. */
                ghost={
                  preview?.index === i
                    ? { startMin: preview.startMin, minutes: preview.minutes }
                    : null
                }
                onPick={(cursorMin) => openSlot(i, cursorMin)}
              >
                {/* The form opens at the hour it was clicked, inside the
                    column, at the height the block will occupy. A dialog in
                    the middle of the screen would have made you remember which
                    Tuesday you meant. */}
                {adding?.index === i && (
                  <SlotForm
                    day={day}
                    startMin={adding.startMin}
                    span={span}
                    classes={classes.filter((c) => !c.hidden)}
                    onCancel={() => setAdding(null)}
                    onAdd={(input) => void addAt(i, adding.startMin, input)}
                  />
                )}

                {shown[i].map((p) => (
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
                    onDeleteTask={deleteTask}
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
          selection={selection}
          planning={generating}
          chosen={chosenUnplanned.size}
          onAutoplan={() =>
            void fillGaps(
              tasks,
              chosenUnplanned.size ? chosenUnplanned : undefined,
            )
          }
        />

        {/*
          No drop animation. The default flies the overlay back to the rect the
          drag started from before the commit re-renders the block in its new
          cell, which reads as the card drifting home and then jumping. The
          drop is already drawn by the preview, so the overlay has nothing left
          to say once the pointer is released.
        */}
        <DragOverlay dropAnimation={null}>
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

      {/*
        What decides a week, under the week it decides.

        The chat is first because it is the one that can write the other, and
        reading it after the routines form would make that form read as its
        settings rather than as the plain thing it is and remains.
      */}
      <PlannerChat
        tasks={tasks}
        routines={routines}
        routineOverrides={routineOverrides}
        routineSkips={routineSkips}
        userId={userId}
        /* The rail as the model should see it: what has no hour against it. */
        unplaced={outstanding.map((u) => ({
          task_id: u.task_id,
          minutes: u.minutes,
        }))}
        from={planFrom}
        to={addDays(planFrom, DAYS)}
        /*
         * Reload, and stop there.
         *
         * There is deliberately no plan run here any more. The diff was a list
         * of block-level changes and they have already been written; running
         * the planner on top would move things the person was never shown,
         * which is precisely what accepting a diff is supposed to rule out. If
         * the changes leave work with no hour against it, the rail says so and
         * Autoplan is one press away — but that press is theirs.
         */
        onApplied={refresh}
      />

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
/** A finger that lifted a block and put it back down where it found it. */
function stationaryTouch(e: DragEndEvent | DragCancelEvent): boolean {
  const byTouch = String((e.activatorEvent as Event | null)?.type).startsWith(
    "touch",
  );
  return byTouch && Math.abs(e.delta.x) < 8 && Math.abs(e.delta.y) < 8;
}

/** Toggle one, said in the language `select` already speaks. */
const TOUCH_TOGGLE = { ctrlKey: true, metaKey: false, shiftKey: false };

function pointerYOf(e: Event | null): number {
  if (e && "clientY" in e) return (e as PointerEvent).clientY;
  // A touch keeps its coordinates one level down, and reading past it would
  // put every dropped block at the foot of the axis instead of under the
  // finger — the height of the cursor in the column is the time.
  if (typeof TouchEvent !== "undefined" && e instanceof TouchEvent) {
    const t = e.touches[0] ?? e.changedTouches[0];
    if (t) return t.clientY;
  }
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
  ghost,
  onPick,
  children,
}: {
  day: Date;
  index: number;
  marks: { min: number; label: boolean }[];
  span: number;
  /** Hands the track element up, so a drop can measure it where it now is. */
  register: (el: HTMLElement | null) => void;
  /** Where the thing in the air would land, or null if it is elsewhere. */
  ghost: { startMin: number; minutes: number } | null;
  /** A click on empty track, as a time on this day's axis. */
  onPick: (cursorMin: number) => void;
  children: React.ReactNode;
}) {
  const today = isToday(day);
  const { setNodeRef, isOver } = useDroppable({ id: `day:${index}` });
  const track = useRef<HTMLElement | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);

  /*
   * A click on the empty part of a day is an hour, and an offer to fill it.
   *
   * Guarded twice, because this element is also the drop target for every drag
   * on the screen. A press that travelled more than a few pixels was a drag and
   * its click is the tail of it, not a new gesture; a press that landed on a
   * block belongs to the block. Neither guard is optional — without the first,
   * every drop would end by opening a form over the thing you just moved.
   */
  function onClick(e: React.MouseEvent) {
    const from = down.current;
    down.current = null;
    if (!from) return;
    if (Math.abs(e.clientX - from.x) > 4 || Math.abs(e.clientY - from.y) > 4) return;
    if ((e.target as HTMLElement).closest(".bar, .add-pop")) return;

    const el = track.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.height) return;
    // The same reading a drop takes: height inside the column is a time, off
    // the same axis the blocks are drawn against, measured from the foot.
    const fromFoot = (rect.bottom - e.clientY) / rect.height;
    onPick(GRID_START_MIN + fromFoot * span);
  }

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
          track.current = el;
        }}
        className={`day-track${isOver ? " over" : ""}`}
        onPointerDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={onClick}
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

        {/*
          The landing spot, drawn at the size and place the block will actually
          take. An outline rather than a filled bar, so it reads as a promise
          about the chart and not as another thing already on it — and it
          carries the two times, because "here" is only half the answer when
          the half-hour either side is equally plausible.
        */}
        {ghost && (
          <div
            className="bar-ghost"
            aria-hidden="true"
            style={{
              bottom: `${((ghost.startMin - GRID_START_MIN) / span) * 100}%`,
              height: `${(ghost.minutes / span) * 100}%`,
            }}
          >
            <span className="ghost-time">
              {clockOfMinutes(ghost.startMin)}–
              {clockOfMinutes(ghost.startMin + ghost.minutes)}
            </span>
          </div>
        )}

        {children}
      </div>
    </section>
  );
}

/**
 * The form that opens where you clicked an empty hour.
 *
 * Three fields, and two of them optional. A title is the only thing the app
 * genuinely cannot supply — the class can be picked later on the board and an
 * unestimated task is planned against its class's median and says so — and a
 * form that asked for six things at the moment somebody thought of one would
 * be a form nobody finishes. The hour itself is already answered: it is where
 * the click was, and it is printed at the top so it can be checked without
 * being retyped.
 *
 * It produces a real task, not a floating appointment. That is the whole point
 * of it being here: something written onto Thursday afternoon is on the To do
 * board a second later, counts towards the term, and can be marked done from
 * either screen — as opposed to a note in the shape of a calendar entry that
 * only this grid knows about.
 */
function SlotForm({
  day,
  startMin,
  span,
  classes,
  onAdd,
  onCancel,
}: {
  day: Date;
  startMin: number;
  span: number;
  classes: Class[];
  onAdd: (input: { title: string; classId: string; estimate: number | null }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [classId, setClassId] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const minutes = sitting(estimate ?? DEFAULT_ESTIMATE_MINUTES);

  /*
   * Escape closes it, and a click anywhere else does too — the same contract
   * a block's own panel keeps, because on this screen they are the same kind
   * of thing: something open over a column that must not need finding a small
   * button to be rid of.
   */
  const box = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onCancel();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const t = setTimeout(() => {
      document.addEventListener("pointerdown", away);
      document.addEventListener("keydown", esc);
    });
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onCancel]);

  return (
    <form
      ref={box}
      className={`add-pop${(startMin - GRID_START_MIN) / span > 0.55 ? " vflip" : ""}`}
      style={{ bottom: `${((startMin - GRID_START_MIN) / span) * 100}%` }}
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onAdd({ title, classId, estimate });
      }}
    >
      <p className="pop-title">
        {day.toLocaleDateString(undefined, { weekday: "long" })} ·{" "}
        {clockOfMinutes(startMin)}–{clockOfMinutes(startMin + minutes)}
      </p>

      <input
        autoFocus
        placeholder="What are you doing then?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <div className="row pop-add-fields">
        <EstimatePicker value={estimate} onChange={setEstimate} />
        <ClassPicker classes={classes} value={classId} onChange={setClassId} />
      </div>

      <div className="row end pop-add-actions">
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
        <button disabled={!title.trim()}>Add</button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */

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
  onDeleteTask,
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
  /** Delete the work this block is an hour of. Only ever offered on work. */
  onDeleteTask: (task: Task) => void;
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

  /*
   * An hour set aside for work that was already due by the time it starts.
   *
   * Marked rather than prevented. Autoplan will not do this and neither will
   * the chat — both refuse and say why — but a drag will, and it should: a
   * deadline you are going to miss is still a week you have to plan, and the
   * app refusing to let you write down what you are actually going to do would
   * only mean doing it somewhere the app cannot see.
   *
   * So the block goes exactly where it was put, and says what it is. Measured
   * from the start, not the end: a session beginning after the deadline is
   * unambiguously late, whereas one that merely runs over is the ordinary
   * shape of finishing something on the day it is due.
   */
  const late = Boolean(
    task?.due_at && Date.parse(block.starts_at) > Date.parse(task.due_at),
  );

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
      /* Android raises a context menu about half a second into a press, and
         the touch stream it cancels on the way there is the one carrying the
         drag that press was starting. */
      onContextMenu={(e) => e.preventDefault()}
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
      }${late ? " late" : ""}${
        minutes < SLIVER_MINUTES ? " sliver" : ""
      }${open ? " open" : ""}`}
      style={{
        bottom: `${box.bottom * 100}%`,
        height: `${box.height * 100}%`,
        left: `${box.left * 100}%`,
        width: `${box.width * 100}%`,
      }}
      title={
        `${title} · ${clockOf(block.starts_at)}–${clockOf(block.ends_at)}` +
        (late && task?.due_at
          ? ` · after the deadline, which was ${formatDue(task.due_at)}`
          : "")
      }
    >
      {/* The name, and only the name. A block too short to hold one is left as
          a bare stripe of colour rather than given an ellipsis to wear — three
          dots in a class colour say less than the colour does on its own. */}
      <span className="bar-name">{title}</span>

      {/* Said, not merely coloured. The red edge is what catches the eye in a
          dense column; the word is what tells you which of the several things
          a red edge could mean this one is. Dropped on a sliver, where there
          is no room for it and the edge has to carry the whole message. */}
      {late && minutes >= SLIVER_MINUTES && <span className="bar-late">Late</span>}

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

          {/*
            Two sentences, and they are not the same sentence.

            Dragging to the rail says "not this hour" and leaves the work
            standing; Delete says the work is not happening. Only work gets the
            second one — a lecture is Google's row and a routine is a rule
            about every Tuesday, and neither is a thing this button could
            honestly delete.
          */}
          <div className="row pop-foot">
            <p className="muted small pop-hint">
              Drag to Unplanned to take it off.
            </p>
            {task && (
              <button
                className="link danger"
                onClick={() => onDeleteTask(task)}
                title="Delete the task itself, hours and all"
              >
                Delete task
              </button>
            )}
          </div>
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
  selection,
  planning,
  chosen,
  onAutoplan,
}: {
  /** True while a plan is being worked out, so the button can say so. */
  planning: boolean;
  /** How many of the items below are selected. Zero means all of them. */
  chosen: number;
  /** Find hours for everything in this list that will take one. */
  onAutoplan: () => void;
  outstanding: {
    task_id: string;
    minutes: number;
    guessed: boolean;
    task: Task;
  }[];
  skipped: PlanBlock[];
  classById: Map<string, Class>;
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
            : "Nothing unplanned."}
        </span>
      </div>

      {/*
        The one button that adds hours to the week, and it lives here rather
        than at the top of the page — next to the work it is offering to place,
        rather than next to the week it used to overwrite.

        It only ever adds. Nothing already on the grid is moved or removed by
        pressing it, which is what makes it safe to press at any point in a
        week you have already been rearranging by hand.
      */}
      {outstanding.length > 0 && (
        <div className="row rail-actions">
          {/*
            The count is on the button rather than only in the sentence beside
            it, because the narrowing has to be legible in the half-second
            before the press — "Autoplan 3" is a different promise from
            "Autoplan", and finding out which one you made from the toast
            afterwards is finding out too late.
          */}
          <button onClick={onAutoplan} disabled={planning}>
            {planning ? "Finding hours…" : chosen ? `Autoplan ${chosen}` : "Autoplan"}
          </button>
          <span className="muted small">
            {chosen
              ? `Finds hours for the ${chosen} selected. Nothing already on the grid moves.`
              : "Finds hours for everything below. Nothing already on the grid moves."}
          </span>
        </div>
      )}

      {empty ? null : (
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
      onContextMenu={(e) => e.preventDefault()}
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

/**
 * Whether a column is the day you are currently in — by the rollover, not the
 * clock.
 *
 * At half past one in the morning the day you are having is still yesterday's,
 * and the column tinted as "today" should be the one your evening is drawn in.
 */
function isToday(day: Date): boolean {
  return day.getTime() === logicalDayOf(new Date()).getTime();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

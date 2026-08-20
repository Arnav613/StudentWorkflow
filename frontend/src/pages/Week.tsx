import { useEffect, useMemo, useState } from "react";
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
import { errorText, toast } from "../lib/toast";
import { formatDue } from "../lib/board";
import {
  MAX_SESSION_MINUTES,
  PLAN_DAYS,
  blockMinutes,
  byDay,
  classMedians,
  clockOf,
  formatMinutes,
  hhmmOf,
  planDays,
  planWeek,
  snapMinutes,
  timeForSlot,
  unscheduled,
} from "../lib/schedule";
import RoutinesPanel from "../components/RoutinesPanel";
import ScopeDialog, { type Scope } from "../components/ScopeDialog";
import TimePicker from "../components/TimePicker";
import type { DataStore } from "../hooks/useData";
import type {
  Class,
  PlanBlock,
  Routine,
  RoutineOverride,
  RoutineSkip,
  Task,
} from "../lib/types";

const DAYS = PLAN_DAYS;

/**
 * The Week: seven days, and what you have actually decided to do in them.
 *
 * The board answers "what is due". This answers "when will I do it", which is
 * the question the board has never been able to answer and the reason a
 * deadline list stops being enough somewhere around week four.
 *
 * Regenerate is a button and never a side effect. A plan that reshuffles
 * itself while you are reading it is not a plan — it is a slot machine — and
 * the moment it moves something you had mentally committed to, you stop
 * believing any of it.
 *
 * Everything on the grid is a row in `plan_blocks` — work, routines and
 * lectures alike. Lectures used to be fetched from Google on every open and
 * drawn on top, which cost a visible pause and made them the one thing on the
 * board that could not be moved. They are mirrored now (see `db.syncCalendar`),
 * so the grid paints from one query and a lecture you are not attending can be
 * dragged off it like anything else — locally, never back to Google.
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
    userId,
  } = store;
  const [generating, setGenerating] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [calendarGranted, setCalendarGranted] = useState<boolean | null>(null);

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

  /** The time on the tile, changed on the tile. Keeps the block's length. */
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
   * A lecture is dismissed rather than deleted — the row is a mirror of
   * Google's, so a delete would last until the next refresh — and it lands in
   * the rail, where it can be dragged back. Work is deleted, and the task it
   * belonged to reappears in the rail on its own because its hours are no
   * longer accounted for.
   */
  async function clear(block: PlanBlock) {
    /*
     * Removing one block of a routine used to remove the routine — every
     * Tuesday of it, from a button sitting on a single Tuesday's card. Skipping
     * one gym session is a far more ordinary thing to want than giving up the
     * gym, and it was the one thing the card could not say.
     *
     * So removal asks the same three-way question a move does, and nothing
     * happens until it is answered.
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
   * The drop targets on this screen are nested — a card inside a column — and
   * the default rectangle test happily reports the column when the cursor is
   * plainly on a card, which is how a block dropped at the bottom of Thursday
   * used to land at the top of it. `pointerWithin` asks the only question the
   * gesture is actually making: what is under the cursor. The fallback covers
   * a keyboard drag, where there is no cursor to ask about.
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

    /* Off the board, into the rail. */
    if (over === "unplanned") {
      if (subject.kind === "task") return;
      await clear(subject.block);
      return;
    }

    const at = parseDrop(over);
    if (!at) return;
    const day = days[at.day];
    if (!day) return;

    /*
     * Where it lands is when it happens.
     *
     * The old rule kept the block's clock and only changed its date, so an 8am
     * session dropped at the foot of Thursday snapped back to the top of the
     * column — the app overruling the one instruction the drag carried. Now
     * the gap you dropped into decides the time, and the block keeps only its
     * length: a forty-minute reading dropped into a two-hour hole stays forty
     * minutes, and the rest of the hole stays free.
     */
    const held = subject.kind === "task" ? null : subject.block.id;
    const list = blocksByDay[at.day];
    const start = timeForSlot({
      day,
      after: lastBefore(list, at.index, held),
      before: firstFrom(list, at.index, held),
      minutes: subject.minutes,
      // Its own clock is the answer unless a neighbour is in the way. A task
      // out of the rail has never had one.
      current: subject.kind === "task" ? null : new Date(subject.block.starts_at),
    });

    if (start.getTime() + subject.minutes * 60_000 <= Date.now()) {
      toast("That hour has already gone", "info");
      return;
    }

    try {
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
          already has, so a permission is asked for in one place rather than
          wherever it happens to be missed. */}
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
        <div className="week">
          {days.map((day, i) => (
            <DayColumn key={day.getTime()} day={day}>
              {blocksByDay[i].length === 0 ? (
                <ul className="list blocks">
                  <DropSlot id={`tail:${i}`} className="slot-empty">
                    <span className="muted small">Free</span>
                  </DropSlot>
                </ul>
              ) : (
                <ul className="list blocks">
                  <DropSlot id={`gap:${i}:0`} />
                  {blocksByDay[i].map((block, k) => (
                    <BlockCard
                      key={block.id}
                      block={block}
                      slot={`card:${i}:${k}`}
                      gap={`gap:${i}:${k + 1}`}
                      task={block.task_id ? taskById.get(block.task_id) ?? null : null}
                      routine={
                        block.routine_id
                          ? routineById.get(block.routine_id) ?? null
                          : null
                      }
                      cls={classById}
                      onRetime={(t) => void retime(block, t)}
                      onClear={() => void clear(block)}
                      onOpenClass={onOpenClass}
                    />
                  ))}
                  <DropSlot id={`tail:${i}`} className="slot-tail" />
                </ul>
              )}
            </DayColumn>
          ))}
        </div>

        {/*
          The rail exists because a planner that silently compresses the week to
          make it look achievable is worse than none. These are hours the plan
          could not find a home for; they have not gone anywhere.

          It is also where things come back to. An hour that passed without the
          work being done stops counting as planned and the task reappears here
          — nothing is deleted and nothing is quietly forgiven.
        */}
        <UnplannedRail
          outstanding={outstanding}
          skipped={skipped}
          classById={classById}
          missed={missed}
        />

        <DragOverlay>
          {dragging && (
            <div className="card overlay">
              {dragging.kind === "task" ? dragging.task.title : dragging.title}
            </div>
          )}
        </DragOverlay>
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
 * The columns render whatever order the array is in — the loading query sorts
 * by starts_at, and an optimistic edit has to keep that promise itself or a
 * card lands visually last in a day it belongs in the middle of.
 */
function inOrder(blocks: PlanBlock[]): PlanBlock[] {
  return [...blocks].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
}

/**
 * How long a task claims when it is dragged onto a day.
 *
 * One sitting, not the whole job. Dragging a six-hour essay onto Thursday
 * should book Thursday evening, not all of Thursday — and the remainder stays
 * in the rail, visible, where Replan can find hours for it.
 */
function sitting(minutes: number): number {
  return Math.min(snapMinutes(minutes), MAX_SESSION_MINUTES);
}

/** `gap:3:2` / `card:3:2` / `tail:3` → which column, and which position in it. */
function parseDrop(id: string): { day: number; index: number } | null {
  const [kind, a, b] = id.split(":");
  const day = Number(a);
  if (!Number.isFinite(day)) return null;
  if (kind === "tail") return { day, index: Number.MAX_SAFE_INTEGER };
  if (kind === "gap" || kind === "card") return { day, index: Number(b) };
  return null;
}

/** The item below the gap, skipping the block being dragged out of it. */
function firstFrom(
  list: PlanBlock[],
  index: number,
  held: string | null,
): PlanBlock | null {
  for (let i = Math.max(0, index); i < list.length; i++) {
    if (list[i].id !== held) return list[i];
  }
  return null;
}

/** The item above the gap, skipping the block being dragged out of it. */
function lastBefore(
  list: PlanBlock[],
  index: number,
  held: string | null,
): PlanBlock | null {
  for (let i = Math.min(index, list.length) - 1; i >= 0; i--) {
    if (list[i].id !== held) return list[i];
  }
  return null;
}

/**
 * A place to drop something: between two cards, or at the end of a column.
 *
 * Nearly invisible until a drag is in flight, and then it opens into a real
 * target. A permanent gutter between every card would cost a seven-column grid
 * more vertical space than the cards themselves.
 */
function DropSlot({
  id,
  className = "",
  children,
}: {
  id: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <li
      ref={setNodeRef}
      className={`drop-slot ${className}${isOver ? " over" : ""}`}
    >
      {children}
    </li>
  );
}

function DayColumn({ day, children }: { day: Date; children: React.ReactNode }) {
  const today = isSameDay(day, new Date());
  return (
    <section className={`column day${today ? " today" : ""}`}>
      <h2>
        {day.toLocaleDateString(undefined, { weekday: "short" })}
        <span className="count">{day.getDate()}</span>
      </h2>
      {children}
    </section>
  );
}

/**
 * One block: work, a routine, or a lecture.
 *
 * A routine is not editable here — its time comes from the routine, and
 * changing it for one Tuesday only would make the routine a lie everywhere
 * else. Edit the routine below instead.
 *
 * A lecture is. It is a mirror of Google's row, and moving or dropping it says
 * something about your week rather than about the lecture: nothing here is
 * ever written back to the calendar, so skipping a class does not email
 * anybody.
 */
function BlockCard({
  block,
  slot,
  gap,
  task,
  routine,
  cls,
  onRetime,
  onClear,
  onOpenClass,
}: {
  block: PlanBlock;
  slot: string;
  gap: string;
  task: Task | null;
  routine: Routine | null;
  cls: Map<string, Class>;
  onRetime: (hhmm: string) => void;
  onClear: () => void;
  onOpenClass: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block:${block.id}`,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: slot });

  const event = Boolean(block.google_event_id);
  const klass = task?.class_id ? cls.get(task.class_id) : undefined;
  const hue = routine || event ? "hue-none" : klass ? `hue-${klass.color}` : "hue-none";
  const title = task?.title ?? block.title ?? routine?.title ?? "Untitled";
  const start = new Date(block.starts_at);
  const past = Date.parse(block.ends_at) <= Date.now();

  return (
    <>
      <li
        ref={(node) => {
          setNodeRef(node);
          setDropRef(node);
        }}
        {...listeners}
        {...attributes}
        className={`card block ${hue}${isDragging ? " dragging" : ""}${
          routine ? " routine" : ""
        }${event ? " event" : ""}${block.locked ? " locked" : ""}${
          past ? " past" : ""
        }${isOver ? " slot-over" : ""}`}
      >
        {/*
          The controls opt out of the drag rather than the card opting in.

          The handle used to be the title alone, which meant most of the card
          was inert and you had to find the one line that moved it. Now the
          card drags from anywhere and the two things that are not a drag —
          the clock and the buttons — stop the gesture before it starts. The
          five-pixel activation distance already lets an ordinary click
          through; this covers the click that wanders.
        */}
        <div
          className="row block-time"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/*
            The time is the control.

            There was a Move button beside it that opened a picker showing the
            same number the card was already displaying — two things saying one
            thing, and the editable one was the one that did not look editable.
          */}
          <TimePicker
            value={hhmmOf(start.getHours() * 60 + start.getMinutes())}
            compact
            display={`${clockOf(block.starts_at)} – ${clockOf(block.ends_at)}`}
            onChange={onRetime}
          />
        </div>

        <span className="block-title">{title}</span>

        <div
          className="row block-actions"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {event ? (
            <span className="muted small">Calendar</span>
          ) : routine ? (
            <span className="muted small">Repeats</span>
          ) : klass ? (
            <button className="link" onClick={() => onOpenClass(klass.id)}>
              {klass.name}
            </button>
          ) : null}
          <span className="grow" />
          <button
            className="link danger"
            onClick={onClear}
            title={
              event
                ? "Not attending. Never written back to Google."
                : routine
                  ? "Removes it from every day it repeats on"
                  : undefined
            }
          >
            Remove
          </button>
        </div>

      </li>
      <DropSlot id={gap} />
    </>
  );
}

/* -------------------------------------------------------------------------- */

function UnplannedRail({
  outstanding,
  skipped,
  classById,
  missed,
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
  children,
}: {
  id: string;
  hue: string;
  title: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  return (
    <li
      ref={setNodeRef}
      className={`${hue} rail-item${isDragging ? " dragging" : ""}`}
      {...listeners}
      {...attributes}
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

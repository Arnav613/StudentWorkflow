import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import * as db from "../lib/db";
import { getBusy, type BusyResponse } from "../lib/api";
import { toast } from "../lib/toast";
import { formatDue } from "../lib/board";
import {
  blockMinutes,
  byDay,
  classMedians,
  clockOf,
  formatMinutes,
  planDays,
  planWeek,
  unscheduled,
} from "../lib/schedule";
import RoutinesPanel from "../components/RoutinesPanel";
import TimePicker from "../components/TimePicker";
import type { DataStore } from "../hooks/useData";
import type { Class, PlanBlock, Routine, Task } from "../lib/types";

const DAYS = 7;

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
 */
export default function WeekPage({
  store,
  onOpenClass,
}: {
  store: DataStore;
  onOpenClass: (id: string) => void;
}) {
  const { classes, tasks, routines, planBlocks, planFrom, refresh, userId } = store;
  const [generating, setGenerating] = useState(false);
  const [calendar, setCalendar] = useState<BusyResponse | "off" | null>(null);

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
   * The calendar is fetched once, on open, and its failure is never fatal.
   * Render sleeps, the scope may never have been granted, and the whole
   * feature is "the planner also knows about your lectures" — none of which
   * is worth a red panel over a week that is otherwise correct.
   */
  useEffect(() => {
    let live = true;
    getBusy(DAYS)
      .then((res) => live && setCalendar(res))
      // Every failure means the same thing here: plan without it. A dead
      // grant, a sleeping Render and a deployment with Google switched off
      // are three different problems and none of them is this screen's to
      // report — the Classes tab already owns the reconnect banner.
      .catch(() => live && setCalendar("off"));
    return () => {
      live = false;
    };
  }, []);

  const blocksByDay = byDay(planBlocks, days);
  const outstanding = unscheduled(tasks, planBlocks, medians)
    .map((u) => ({ ...u, task: taskById.get(u.task_id) }))
    .filter((u): u is typeof u & { task: Task } => Boolean(u.task));

  const plannedMinutes = planBlocks
    .filter((b) => b.task_id)
    .reduce((sum, b) => sum + blockMinutes(b), 0);

  async function regenerate() {
    setGenerating(true);
    try {
      const busy = calendar && calendar !== "off" && calendar.granted ? calendar.busy : [];
      // `from` is now, not planFrom: today's morning is over and nothing can
      // be scheduled into it. The columns still start at midnight so the week
      // reads as a week.
      const plan = planWeek({
        tasks,
        routines,
        busy,
        locked: planBlocks.filter((b) => b.locked),
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
            : `Planned. ${plan.unplaced.length} thing${plan.unplaced.length === 1 ? "" : "s"} did not fit this week.`,
          "info",
        );
      } else {
        toast("Week planned", "success");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not plan the week", "error");
    } finally {
      setGenerating(false);
    }
  }

  /* --- Manual edits. Both of these lock the block. See db.moveBlock. ------ */

  async function moveTo(block: PlanBlock, day: Date) {
    const start = new Date(block.starts_at);
    const next = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      start.getHours(),
      start.getMinutes(),
    );
    await commitMove(block, next);
  }

  async function retime(block: PlanBlock, hhmm: string) {
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
  }

  async function commitMove(block: PlanBlock, start: Date) {
    if (start.getTime() < Date.now()) {
      toast("That time has already passed", "info");
      return;
    }
    const length = blockMinutes(block);
    const end = new Date(start.getTime() + length * 60_000);
    try {
      await db.moveBlock(block.id, start.toISOString(), end.toISOString());
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not move that block", "error");
    }
  }

  async function drop(block: PlanBlock) {
    try {
      await db.deleteBlock(block.id);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove that block", "error");
    }
  }

  /* --- Drag ---------------------------------------------------------------*/

  const [dragging, setDragging] = useState<PlanBlock | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(e: DragStartEvent) {
    setDragging(planBlocks.find((b) => b.id === e.active.id) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const target = e.over?.id;
    if (typeof target !== "string" || !target.startsWith("day-")) return;
    const day = days[Number(target.slice(4))];
    const block = planBlocks.find((b) => b.id === e.active.id);
    if (!day || !block) return;
    const from = new Date(block.starts_at);
    if (
      from.getFullYear() === day.getFullYear() &&
      from.getMonth() === day.getMonth() &&
      from.getDate() === day.getDate()
    ) {
      return; // dropped back on its own day: not an edit, so do not lock it
    }
    void moveTo(block, day);
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
        <button onClick={() => void regenerate()} disabled={generating}>
          {generating ? "Planning…" : planBlocks.length ? "Replan" : "Plan the week"}
        </button>
      </div>

      {/* Said once, quietly, and only when it is true. The planner works
          without the calendar; it just assumes more of the day is free than
          it really is, and someone should know that is the assumption.

          No button. Granting the permission is not this screen's job — the
          Classes tab raises it as part of the one reconnect prompt the app
          already has, so a permission is asked for in one place rather than
          wherever it happens to be missed. */}
      {calendar === "off" || (calendar && !calendar.granted) ? (
        <p className="muted small notice">
          Planning without your calendar, so every waking hour counts as free.
        </p>
      ) : null}

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="week">
          {days.map((day, i) => (
            <DayColumn key={day.getTime()} index={i} day={day}>
              {blocksByDay[i].length === 0 ? (
                <p className="muted small day-empty">Free</p>
              ) : (
                <ul className="list blocks">
                  {blocksByDay[i]
                    .slice()
                    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
                    .map((block) => (
                      <BlockCard
                        key={block.id}
                        block={block}
                        task={block.task_id ? taskById.get(block.task_id) ?? null : null}
                        routine={
                          block.routine_id ? routineById.get(block.routine_id) ?? null : null
                        }
                        cls={classById}
                        onRetime={(t) => void retime(block, t)}
                        onDrop={() => void drop(block)}
                        onOpenClass={onOpenClass}
                      />
                    ))}
                </ul>
              )}
            </DayColumn>
          ))}
        </div>

        <DragOverlay>
          {dragging && (
            <div className="card overlay">
              {dragging.task_id
                ? taskById.get(dragging.task_id)?.title ?? "Task"
                : routineById.get(dragging.routine_id ?? "")?.title ?? "Routine"}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/*
        The rail exists because a planner that silently compresses the week to
        make it look achievable is worse than none. These are hours the plan
        could not find a home for; they have not gone anywhere.
      */}
      <section className="panel">
        <div className="panel-head">
          <h2>Unplanned</h2>
          <span className="muted small">
            {outstanding.length
              ? `${formatMinutes(outstanding.reduce((s, u) => s + u.minutes, 0))} with no hour against it`
              : "Everything on the board has time set aside."}
          </span>
        </div>

        {outstanding.length > 0 && (
          <ul className="list unplaced">
            {outstanding
              .sort(
                (a, b) =>
                  (Date.parse(a.task.due_at ?? "") || Infinity) -
                  (Date.parse(b.task.due_at ?? "") || Infinity),
              )
              .map((u) => {
                const cls = u.task.class_id ? classById.get(u.task.class_id) : undefined;
                return (
                  <li key={u.task_id} className={cls ? `hue-${cls.color}` : "hue-none"}>
                    <span className="dot" />
                    <span className="grow">{u.task.title}</span>
                    <span className={u.guessed ? "muted small guessed" : "muted small"}>
                      {formatMinutes(u.minutes)}
                    </span>
                    <span className="muted small">{formatDue(u.task.due_at)}</span>
                  </li>
                );
              })}
          </ul>
        )}
      </section>

      <RoutinesPanel store={store} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DayColumn({
  index,
  day,
  children,
}: {
  index: number;
  day: Date;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day-${index}` });
  const today = isSameDay(day, new Date());

  return (
    <section
      ref={setNodeRef}
      className={`column day${isOver ? " over" : ""}${today ? " today" : ""}`}
    >
      <h2>
        {day.toLocaleDateString(undefined, { weekday: "short" })}
        <span className="count">{day.getDate()}</span>
      </h2>
      {children}
    </section>
  );
}

/**
 * One block.
 *
 * A routine block is not editable here — its time comes from the routine, and
 * changing it for one Tuesday only would make the routine a lie everywhere
 * else. Edit the routine below instead.
 */
function BlockCard({
  block,
  task,
  routine,
  cls,
  onRetime,
  onDrop,
  onOpenClass,
}: {
  block: PlanBlock;
  task: Task | null;
  routine: Routine | null;
  cls: Map<string, Class>;
  onRetime: (hhmm: string) => void;
  onDrop: () => void;
  onOpenClass: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: block.id,
    disabled: Boolean(routine),
  });

  const klass = task?.class_id ? cls.get(task.class_id) : undefined;
  const hue = routine ? "hue-none" : klass ? `hue-${klass.color}` : "hue-none";
  const title = task?.title ?? routine?.title ?? "Untitled";

  const start = new Date(block.starts_at);
  const hhmm = `${`${start.getHours()}`.padStart(2, "0")}:${`${start.getMinutes()}`.padStart(2, "0")}`;

  return (
    <li
      ref={setNodeRef}
      {...(routine ? {} : listeners)}
      {...(routine ? {} : attributes)}
      className={`card block ${hue}${isDragging ? " dragging" : ""}${
        routine ? " routine" : ""
      }${block.locked ? " locked" : ""}`}
    >
      <div className="row block-time">
        <span className="muted small grow">
          {clockOf(block.starts_at)} – {clockOf(block.ends_at)}
        </span>
        {/* Said, not implied. A locked block is the one thing on this screen
            that Replan will not touch, and that is worth a word. */}
        {block.locked && <span className="tag">Kept</span>}
      </div>

      <span className="block-title">{title}</span>

      {routine ? (
        <span className="muted small">Routine</span>
      ) : (
        <div className="row block-actions">
          <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Close" : "Move"}
          </button>
          {klass && (
            <button className="link" onClick={() => onOpenClass(klass.id)}>
              {klass.name}
            </button>
          )}
          <span className="grow" />
          <button className="link danger" onClick={onDrop}>
            Remove
          </button>
        </div>
      )}

      {open && !routine && (
        <div className="block-retime">
          <span className="label">Start at</span>
          <TimePicker value={hhmm} onChange={onRetime} />
        </div>
      )}
    </li>
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

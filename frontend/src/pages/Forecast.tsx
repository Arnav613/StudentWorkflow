import { useEffect, useMemo, useState } from "react";
import { getCalendar, type CalendarEvent } from "../lib/api";
import { FORECAST_DAYS, forecast, type ForecastDay } from "../lib/forecast";
import { classMedians, formatMinutes } from "../lib/schedule";
import type { DataStore } from "../hooks/useData";
import type { Class } from "../lib/types";

/**
 * Forecast: the fortnight, and whether it fits.
 *
 * The third question this app asks, after "what am I taking" and "what do I
 * do next" — and the only one with a useful answer in advance. A deadline
 * list tells you Thursday the fourteenth is busy on the fourteenth. This tells
 * you now, while moving something is still a decision rather than an apology.
 *
 * Two figures and no more. Hours due per day, stacked by class, against the
 * hours that day actually has; and underneath, what is outstanding per class
 * with the count the planner could not place. Everything here is derived —
 * from `tasks` and the planner's own capacity arithmetic — so there is no
 * table behind this screen, nothing to keep in step, and no way for it to
 * disagree with the week.
 */
export default function ForecastPage({
  store,
  onOpenClass,
}: {
  store: DataStore;
  onOpenClass: (id: string) => void;
}) {
  const { classes, tasks, routines, routineOverrides, planBlocks } = store;
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [calendarGranted, setCalendarGranted] = useState<boolean | null>(null);

  /*
   * A fortnight of calendar, for the capacity line only.
   *
   * The week grid mirrors seven days of events into `plan_blocks`; this needs
   * fourteen, and it needs no titles, no ids and nothing written down — a
   * chart is not a second copy of your calendar. Until it lands (or if it
   * never does) the mirrored blocks stand in, which is a correct answer for
   * the first week and an optimistic one for the second. Optimistic and
   * improving beats a spinner in front of a chart that is already right about
   * everything else.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await getCalendar(FORECAST_DAYS);
        if (!live) return;
        setCalendarGranted(res.granted);
        if (res.granted) setEvents(res.events);
      } catch {
        // The Classes tab owns the reconnect prompt and the Week tab owns the
        // sync. A chart has nothing to add to either.
        if (live) setCalendarGranted(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const classById = useMemo(
    () => new Map<string, Class>(classes.map((c) => [c.id, c])),
    [classes],
  );
  const medians = useMemo(() => classMedians(tasks), [tasks]);

  /*
   * Which hours Google has, resolved down to one list.
   *
   * A lecture you dropped is not busy time and a lecture you moved is busy at
   * the time you moved it to — two facts that live on the mirrored block and
   * that Google's copy knows nothing about. So the fetched events win on
   * everything except those, and the local row wins on those.
   */
  const busy = useMemo(() => {
    const mirrored = planBlocks.filter((b) => b.google_event_id);
    const local = mirrored.filter((b) => b.dismissed || b.locked);
    const overridden = new Set(local.map((b) => b.google_event_id));
    const moved = local
      .filter((b) => b.locked && !b.dismissed)
      .map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at }));
    return events
      ? [...events.filter((e) => !overridden.has(e.id)), ...moved]
      : mirrored.filter((b) => !b.dismissed);
  }, [events, planBlocks]);

  /*
   * One instant, fixed for the life of the tab — the same reasoning as
   * `useData.planFrom`. A `now` that crept forward on every render would
   * redraw today's capacity a minute shorter each time and, at the wrong
   * moment, move the first column onto tomorrow while the chart was on screen.
   */
  const [now] = useState(() => new Date());

  const view = useMemo(
    () =>
      forecast({
        tasks,
        routines,
        routineOverrides,
        busy,
        // Routine blocks somebody moved by hand. Locked *task* blocks are
        // deliberately left out — see ForecastInput.locked.
        locked: planBlocks.filter((b) => b.locked && b.routine_id),
        blocks: planBlocks.filter((b) => !b.dismissed),
        from: now,
        medians,
      }),
    [tasks, routines, routineOverrides, busy, planBlocks, now, medians],
  );

  const worst = view.days.reduce<ForecastDay | null>(
    (a, d) => (d.over && (!a || d.demandMinutes - d.capacity > a.demandMinutes - a.capacity) ? d : a),
    null,
  );
  const legend = view.byClass.filter((l) => l.minutes > 0);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Forecast</h1>
        <p className="muted small">
          {view.totalMinutes === 0
            ? "Nothing outstanding. The next fortnight is yours."
            : worst
              ? `${formatMinutes(view.totalMinutes)} of work outstanding. ${dayName(worst.day)} the ${worst.day.getDate()} asks for more than it has.`
              : `${formatMinutes(view.totalMinutes)} of work outstanding, and every day of the next fortnight has room for what falls on it.`}
        </p>
      </div>

      {/* Said once, and only where it changes what the chart means. Without
          the calendar every lecture reads as a free hour, which makes the
          capacity line generous in exactly the way a forecast must not be. */}
      {calendarGranted === false && (
        <p className="muted small notice">
          Forecasting without your calendar, so lectures and meetings count as
          free hours here.
        </p>
      )}

      <section className="panel forecast-panel">
        <Chart days={view.days} peak={view.peak} classById={classById} />

        {legend.length > 0 && (
          <ul className="forecast-legend small">
            {legend.map((l) => (
              <li key={l.class_id ?? "none"}>
                <span
                  className={`hue-dot ${hueOf(l.class_id, classById)}`}
                  aria-hidden="true"
                />
                {nameOf(l.class_id, classById)}
              </li>
            ))}
          </ul>
        )}

        {/* Two things the columns cannot show, and both of them are hours you
            still owe. Silence about them would make an honest chart lie by
            omission — which is the same lie as an over-full week that looks
            achievable. */}
        <p className="muted small">
          The line is the hours each day has left after lectures, routines and
          sleep.
          {view.undated > 0 &&
            ` ${formatMinutes(view.undatedMinutes)} across ${view.undated} undated thing${view.undated === 1 ? "" : "s"} sits on no day and is not drawn.`}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Outstanding</h2>
          {view.unplanned > 0 ? (
            <p className="muted small">
              {/* Phase 07 returns this number and nothing was doing anything
                  with it. It is the honest one: hours you owe that no hour of
                  the week has been given to. */}
              {view.unplanned} thing{view.unplanned === 1 ? "" : "s"} —{" "}
              {formatMinutes(view.unplannedMinutes)} — {view.unplanned === 1 ? "is" : "are"}{" "}
              not on the week plan yet.
            </p>
          ) : view.totalMinutes > 0 ? (
            <p className="muted small">Every outstanding hour has a place in the week.</p>
          ) : null}
        </div>

        {legend.length === 0 ? (
          <p className="muted small">Nothing outstanding in any class.</p>
        ) : (
          <ul className="list load-list">
            {legend.map((l) => (
              <li key={l.class_id ?? "none"} className={hueOf(l.class_id, classById)}>
                <span className="hue-dot" aria-hidden="true" />
                {l.class_id ? (
                  <button className="link grow" onClick={() => onOpenClass(l.class_id!)}>
                    {nameOf(l.class_id, classById)}
                  </button>
                ) : (
                  <span className="grow">{nameOf(l.class_id, classById)}</span>
                )}
                <span className="muted small">
                  {l.tasks} thing{l.tasks === 1 ? "" : "s"}
                </span>
                {l.unplannedMinutes > 0 && (
                  <span className="small warn">
                    {formatMinutes(l.unplannedMinutes)} unplanned
                  </span>
                )}
                {/* Italic wherever any of the total rests on a class median.
                    A number the app invented never gets to look like one you
                    typed — the same rule the estimate on a card follows. */}
                <span className={l.guessed ? "guessed" : undefined}>
                  {formatMinutes(l.minutes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/*
 * Hand-rolled SVG, no chart library.
 *
 * Fourteen stacked bars and one dashed line is not a reason to ship a
 * hundred kilobytes of layout engine, and every charting package would want
 * its own colours — while the one thing this drawing must get right is that a
 * class is the same hue here as it is on its card, its chip and its block.
 * `--c` already carries that, and an SVG child of `.hue-blue` inherits it.
 */
const W = 720;
const H = 240;
const PAD_L = 36;
const PAD_R = 6;
const PAD_T = 10;
const PAD_B = 34;

function Chart({
  days,
  peak,
  classById,
}: {
  days: ForecastDay[];
  peak: number;
  classById: Map<string, Class>;
}) {
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const colW = plotW / days.length;
  const barW = Math.min(28, colW * 0.56);

  // Round the top out to a whole number of hours, and pick a tick that leaves
  // three or four lines rather than fourteen.
  const topHours = Math.max(2, Math.ceil(peak / 60));
  const step = topHours <= 4 ? 1 : topHours <= 10 ? 2 : Math.ceil(topHours / 5);
  const top = Math.ceil(topHours / step) * step * 60;

  const y = (minutes: number) => PAD_T + plotH - (minutes / top) * plotH;
  const x = (i: number) => PAD_L + i * colW;

  const ticks: number[] = [];
  for (let h = 0; h <= top / 60; h += step) ticks.push(h);

  return (
    <svg
      className="forecast-chart"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Hours due each day for the next ${days.length} days, against the free hours each day has`}
    >
      {ticks.map((h) => (
        <g key={h}>
          <line
            className="grid"
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y(h * 60)}
            y2={y(h * 60)}
          />
          <text className="axis" x={PAD_L - 8} y={y(h * 60) + 4} textAnchor="end">
            {h}h
          </text>
        </g>
      ))}

      {days.map((d, i) => {
        // Stacked from the ground up, biggest class first, so the tallest
        // block of colour is the one at the bottom and the eye reads the
        // dominant course without the legend.
        let base = 0;
        return (
          <g key={d.day.getTime()} className={d.over ? "col over" : "col"}>
            <title>{summarise(d, classById)}</title>

            {/* A wash behind the whole column, not a red bar. The bar is the
                work, and the work is not the problem — the day is. */}
            {d.over && (
              <rect
                className="col-wash"
                x={x(i)}
                y={PAD_T}
                width={colW}
                height={plotH}
              />
            )}

            {d.demand.map((s) => {
              const yTop = y(base + s.minutes);
              const height = y(base) - yTop;
              base += s.minutes;
              return (
                <rect
                  key={s.class_id ?? "none"}
                  className={`bar ${hueOf(s.class_id, classById)}`}
                  x={x(i) + (colW - barW) / 2}
                  y={yTop}
                  width={barW}
                  height={Math.max(1, height)}
                />
              );
            })}

            {/* The capacity line, drawn per day rather than as one polyline:
                Thursday's free hours are a fact about Thursday, and joining
                them into a curve would imply the hours flow between days. */}
            <line
              className="capacity"
              x1={x(i) + 2}
              x2={x(i) + colW - 2}
              y1={y(Math.min(d.capacity, top))}
              y2={y(Math.min(d.capacity, top))}
            />

            <text
              className="day-label"
              x={x(i) + colW / 2}
              y={H - PAD_B + 16}
              textAnchor="middle"
            >
              {dayName(d.day)}
            </text>
            <text
              className="day-date"
              x={x(i) + colW / 2}
              y={H - PAD_B + 29}
              textAnchor="middle"
            >
              {d.day.getDate()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The tooltip, and the only place the chart says any of this in words. */
function summarise(d: ForecastDay, classById: Map<string, Class>): string {
  const head = `${dayName(d.day)} ${d.day.getDate()} — ${
    d.demandMinutes ? formatMinutes(d.demandMinutes) : "nothing"
  } due, ${formatMinutes(d.capacity)} free`;
  const overdue = d.carriesOverdue ? "\nIncludes work already overdue." : "";
  const lines = d.demand.map(
    (s) => `\n${nameOf(s.class_id, classById)}: ${formatMinutes(s.minutes)}`,
  );
  return head + overdue + lines.join("");
}

function dayName(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function hueOf(id: string | null, classById: Map<string, Class>): string {
  const cls = id ? classById.get(id) : undefined;
  return cls ? `hue-${cls.color}` : "hue-none";
}

function nameOf(id: string | null, classById: Map<string, Class>): string {
  const cls = id ? classById.get(id) : undefined;
  return cls?.name ?? "No class";
}

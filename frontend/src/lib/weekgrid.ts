/*
 * The week as a graph, not a list.
 *
 * Every other view in this app stacks blocks in the order they happen and
 * lets each one be as tall as its text needs. That answers "what is next" and
 * quietly lies about "how much": four half-hour errands and one four-hour
 * essay drew five cards of the same size, so a punishing Thursday and an idle
 * Sunday looked alike.
 *
 * Here a block's height *is* its length, free time is the space left over, and
 * the day reads bottom-up like a bar growing off an axis — 8am at the foot,
 * 11pm at the head. That orientation is deliberate: the eye reads a taller bar
 * as more, and a day filling upward is the shape everyone already knows from
 * every chart they have ever seen. Drawn top-down, the fullest days would
 * point at the floor.
 *
 * Nothing in here touches the database or React. It is arithmetic on
 * intervals: minutes past midnight in, geometry out.
 */

import { DAY_START_HOUR, DAY_END_HOUR, SLOT_MINUTES } from "./schedule";

/** The foot of the axis, in minutes past midnight. */
export const GRID_START_MIN = DAY_START_HOUR * 60;
/** The head of it. A day is allowed to run past this; see `spanOf`. */
export const GRID_END_MIN = DAY_END_HOUR * 60;
/** Fifteen hours, the scale everything else is measured against. */
export const GRID_MINUTES = GRID_END_MIN - GRID_START_MIN;

type Interval = { starts_at: string; ends_at: string };

export type Placed<T> = {
  item: T;
  /** Minutes past midnight of the column's day. May exceed 24 × 60. */
  startMin: number;
  endMin: number;
  /** Which of `lanes` side-by-side tracks this sits in. */
  lane: number;
  /** How many tracks its overlapping cluster needs. Usually 1. */
  lanes: number;
};

/** Midnight of the calendar day a Date falls in. */
export function midnightOf(day: Date): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/**
 * Minutes past midnight of `day`, for an instant.
 *
 * Not `getHours()`: a block running to half past midnight belongs at the top
 * of the day it started in, at 1470, and not at the foot of it at 30. The
 * arithmetic is elapsed time from that day's own midnight, so the number keeps
 * counting upward across the boundary.
 */
export function minutesFrom(day: Date, iso: string | Date): number {
  return (
    (new Date(iso).getTime() - midnightOf(day)) / 60_000
  );
}

/** Minutes past a day's midnight → the instant. Handles past-midnight. */
export function instantOf(day: Date, minutes: number): Date {
  return new Date(midnightOf(day) + minutes * 60_000);
}

/**
 * Lay one day's blocks out, resolving overlaps sideways.
 *
 * Two things at once is not an error to be tidied away — a lecture you have
 * not dropped and a gym session at the same hour is a real clash, and the only
 * honest drawing of it is both, at their true times, sharing the width.
 * Nudging one of them later would make the grid disagree with the clock on its
 * own card.
 *
 * Lanes are assigned per *cluster* of transitively overlapping blocks, so one
 * clash on a Tuesday morning does not halve the width of the whole day.
 */
export function layoutDay<T extends Interval>(day: Date, blocks: T[]): Placed<T>[] {
  const sorted = blocks
    .map((item) => ({
      item,
      startMin: minutesFrom(day, item.starts_at),
      endMin: minutesFrom(day, item.ends_at),
    }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const out: Placed<T>[] = [];

  // One pass, carrying a cluster. A cluster ends the moment a block starts at
  // or after everything in it has finished — exactly when the width is free to
  // reset.
  let cluster: Placed<T>[] = [];
  let clusterEnd = -Infinity;
  /** The finishing time of each open lane, so a block can reuse a free one. */
  let laneEnds: number[] = [];

  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const s of sorted) {
    if (s.startMin >= clusterEnd) flush();

    let lane = laneEnds.findIndex((end) => end <= s.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(s.endMin);
    } else {
      laneEnds[lane] = s.endMin;
    }

    const placed: Placed<T> = { ...s, lane, lanes: 1 };
    cluster.push(placed);
    out.push(placed);
    clusterEnd = Math.max(clusterEnd, s.endMin);
  }
  flush();

  return out;
}

/**
 * How many minutes of axis the whole grid needs.
 *
 * Fifteen hours normally, and more when some day has been pushed past bedtime.
 * All seven columns share the answer: a Thursday drawn to a different scale
 * from a Friday is not a comparison, it is two charts.
 */
export function spanOf(days: Placed<unknown>[][]): number {
  let top = GRID_END_MIN;
  for (const day of days) {
    for (const p of day) top = Math.max(top, p.endMin);
  }
  return Math.max(GRID_MINUTES, top - GRID_START_MIN);
}

/**
 * The hour lines, bottom to top.
 *
 * Fifteen numbers down the side of a chart is a table of contents nobody
 * asked for, so the rules are drawn every hour and only every second one is
 * named. The parity is anchored to the day's start, so the foot of the axis
 * always carries a label — an unlabelled bottom line reads as a border.
 */
export function hourMarks(spanMinutes: number): { min: number; label: boolean }[] {
  const marks: { min: number; label: boolean }[] = [];
  for (let m = GRID_START_MIN; m <= GRID_START_MIN + spanMinutes; m += 60) {
    marks.push({ min: m, label: (m / 60) % 2 === DAY_START_HOUR % 2 });
  }
  // Both ends always carry a number, whatever the parity worked out to. They
  // are the two the chart is bounded by — an unnamed ceiling is the one place
  // a reader has to count rules to find out where the day stops.
  if (marks.length) {
    marks[0].label = true;
    marks[marks.length - 1].label = true;
  }
  return marks;
}

/** Where a block sits on the track, as fractions of the span. Bottom-up. */
export function geometry(
  p: Placed<unknown>,
  spanMinutes: number,
): { bottom: number; height: number; left: number; width: number } {
  return {
    bottom: (p.startMin - GRID_START_MIN) / spanMinutes,
    height: (p.endMin - p.startMin) / spanMinutes,
    left: p.lane / p.lanes,
    width: 1 / p.lanes,
  };
}

/** Snap to the half hour the grid is drawn in. */
export function snapToSlot(minutes: number): number {
  return Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}

/**
 * Where a drop lands, and what it displaces.
 *
 * The cursor names a time and the drop takes it — that is the whole gesture in
 * open space. The interesting case is a cursor over something already there,
 * and the answer is the seam: the lower half of a block means "before this",
 * the upper half means "after it", because a drop is an insertion and never a
 * collision. There is no reading of "drop here" that means "cut this in two".
 *
 * Whatever the start turns out to be, anything the new block then runs into is
 * pushed later by exactly the overlap, and everything above it travels the same
 * distance — which is what keeps their gaps intact. A cascade that closed gaps
 * would rearrange a day you did not ask it to rearrange.
 *
 * The day can end up running past 11pm. That is the point: an evening that does
 * not fit should look like an evening that does not fit, rather than quietly
 * losing the last thing you put in it.
 */
export function insertAt<T extends Interval & { id: string }>({
  day,
  blocks,
  cursorMin,
  minutes,
  heldId = null,
  floorMin = GRID_START_MIN,
}: {
  /** The column being dropped into. */
  day: Date;
  /** That column's blocks, any order. */
  blocks: T[];
  /** Where the pointer was, in minutes past `day`'s midnight. */
  cursorMin: number;
  /** How long the thing being dropped is. */
  minutes: number;
  /** The block being dragged, which cannot collide with itself. */
  heldId?: string | null;
  /** Nothing may start before this — the day's open, or now, on today. */
  floorMin?: number;
}): { startMin: number; shifts: { block: T; startMin: number }[] } {
  const others = blocks
    .filter((b) => b.id !== heldId)
    .map((block) => ({
      block,
      startMin: minutesFrom(day, block.starts_at),
      endMin: minutesFrom(day, block.ends_at),
    }))
    .sort((a, b) => a.startMin - b.startMin);

  let startMin = snapToSlot(cursorMin);
  const under = others.find((o) => cursorMin > o.startMin && cursorMin < o.endMin);
  if (under) {
    const midpoint = (under.startMin + under.endMin) / 2;
    startMin = cursorMin < midpoint ? under.startMin : under.endMin;
  }
  startMin = Math.max(floorMin, startMin);

  const endMin = startMin + minutes;

  const blocking = others.find((o) => o.endMin > startMin && o.startMin < endMin);
  if (!blocking) return { startMin, shifts: [] };

  const by = endMin - blocking.startMin;
  if (by <= 0) return { startMin, shifts: [] };

  const shifts = others
    .filter((o) => o.startMin >= blocking.startMin)
    .map((o) => ({ block: o.block, startMin: o.startMin + by }));

  return { startMin, shifts };
}

/**
 * The class a calendar event belongs to, guessed from its title.
 *
 * Google has no idea this app has classes, so a lecture arrives as a string
 * and nothing else. Matching on the name is a guess, and it is allowed to be:
 * the only thing riding on it is a colour, and a lecture tinted wrongly is a
 * smaller failure than seven grey bars making the busiest hours of the week
 * the least legible ones on the chart.
 *
 * Longest match wins, so "CS-2212" beats "CS" when both are classes.
 */
export function classForEvent<C extends { id: string; name: string }>(
  title: string | null,
  classes: C[],
): C | null {
  if (!title) return null;
  const hay = title.toLowerCase();
  let best: C | null = null;
  for (const c of classes) {
    const needle = c.name.toLowerCase().trim();
    if (!needle) continue;
    if (!hay.includes(needle) && !needle.includes(hay)) continue;
    if (!best || needle.length > best.name.trim().length) best = c;
  }
  return best;
}

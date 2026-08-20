/**
 * What you are actually sitting on, out of what has been marked.
 *
 * Plain arithmetic, pure, in `lib/` — the `lib/board.ts` pattern, and the rule
 * PLAN.md states outright for this phase: no model anywhere near a grade. A
 * rubric is read by Gemini once, into weights a person then checks; from that
 * point the numbers on screen are produced by the twenty lines below and
 * nothing else.
 *
 * The whole of the difficulty is one distinction the naive version gets
 * wrong. In October you have sat one of four assessments. A sum over all the
 * criteria — score times weight, added up — reads 22%, because the three you
 * have not sat contribute nothing, and a student reading 22% in week six will
 * believe they are failing a course they are top of. The number that is
 * useful is the share of the marks *already given out*, and the number of
 * marks already given out is the sum of the weights that have a score.
 *
 * So: an ungraded criterion is excluded, never zeroed. It is the same rule as
 * `estimate_minutes` being null rather than 0 in phase 07 — the absence of a
 * measurement is not a measurement of zero, and an app that conflates the two
 * is confidently wrong in the direction that hurts.
 */

import type { RubricCriterion } from "./types";

export type GradeTotals = {
  /**
   * Your percentage across the graded components only, 0–100, or null when
   * nothing has been marked yet. Null renders as a sentence, never as 0%.
   */
  percent: number | null;
  /**
   * How much of the course that percentage covers — the weights that carry a
   * score. This is what stops `percent` being read as a final grade: 92% of
   * 30% marked is a different claim from 92% of the course.
   */
  gradedWeight: number;
  /** Every weight on the rubric, whether marked or not. */
  totalWeight: number;
  /** How many criteria are still waiting for a mark. */
  ungraded: number;
};

/** A criterion counts toward the total exactly when it has a mark on it. */
export function isGraded(c: Pick<RubricCriterion, "score">): boolean {
  return c.score !== null && Number.isFinite(c.score);
}

/**
 * What one component contributes to the final grade, in percentage points.
 *
 * `score / max_score` and not `score`: a rubric that marks an essay out of 20
 * and an app that reads 18 as 18% is the single most damaging arithmetic
 * mistake available here, and it is one keystroke away from being made.
 */
export function earnedPoints(
  c: Pick<RubricCriterion, "score" | "max_score" | "weight">,
): number | null {
  if (!isGraded(c) || !(c.max_score > 0)) return null;
  return ((c.score as number) / c.max_score) * c.weight;
}

export function totals(criteria: RubricCriterion[]): GradeTotals {
  let earned = 0;
  let gradedWeight = 0;
  let totalWeight = 0;
  let ungraded = 0;

  for (const c of criteria) {
    const weight = Number.isFinite(c.weight) ? c.weight : 0;
    totalWeight += weight;

    const points = earnedPoints(c);
    if (points === null) {
      ungraded += 1;
      continue;
    }
    earned += points;
    gradedWeight += weight;
  }

  return {
    // Guarded on the weight rather than on the count: a marked component
    // worth 0% is a real thing (a formative essay), and dividing by its
    // weight would produce Infinity on a screen someone is reading.
    percent: gradedWeight > 0 ? (earned / gradedWeight) * 100 : null,
    gradedWeight,
    totalWeight,
    ungraded,
  };
}

/**
 * Whether the weights add up, within a hair.
 *
 * Not enforced and not corrected — the review table shows exactly what the
 * handout said. A rubric that sums to 90 usually means a row was missed in
 * extraction, and that is worth a quiet line of text: the fix is to add the
 * row, which nobody would think to do if the app had silently normalised the
 * other four to cover the gap.
 *
 * The tolerance is for the professor who writes 33.3 three times, not for
 * arithmetic slack.
 */
export function weightsLookComplete(totalWeight: number): boolean {
  return Math.abs(totalWeight - 100) < 0.5;
}

/** One decimal, and no trailing ".0" — 92.5% and 88%, never 88.0%. */
export function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

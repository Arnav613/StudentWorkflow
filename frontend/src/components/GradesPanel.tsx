import { useCallback, useEffect, useState } from "react";
import * as db from "../lib/db";
import type { ClassDocument, Rubric, RubricCriterion } from "../lib/types";
import { toast, undoable } from "../lib/toast";
import * as grades from "../lib/grades";
import type { Extraction } from "../lib/api";
import DocumentUpload from "./DocumentUpload";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

type Draft = { key: string; label: string; weight: string; max_score: string };

/**
 * A number typed into a box, or nothing.
 *
 * An empty box is null and not zero, everywhere on this screen. That is the
 * one distinction the whole tab turns on: a midterm you have not sat is not a
 * midterm you scored nought in, and the difference between those two readings
 * is the difference between 92% and 23% in October.
 */
function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Grades: what the course is worth, and what you are sitting on so far.
 *
 * The rubric is read out of a document once, by a model, into weights a person
 * then checks. From that point no model is anywhere near this screen: every
 * number below is produced by `lib/grades.ts`, which is twenty lines of pure
 * arithmetic with a test-shaped signature, for the reason PLAN.md gives
 * outright — one hallucinated weight is a student planning a term around a
 * grade that does not exist.
 */
export default function GradesPanel({
  classId,
  userId,
  aiEnabled,
}: {
  classId: string;
  userId: string;
  aiEnabled: boolean;
}) {
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [criteria, setCriteria] = useState<Record<string, RubricCriterion[]>>({});
  const [loading, setLoading] = useState(true);

  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDoc, setDraftDoc] = useState<ClassDocument | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rs = await db.listRubrics(classId);
      setRubrics(rs);
      // One query per rubric, in parallel. A class has one rubric, sometimes
      // two — a join through PostgREST would buy nothing over this and would
      // need its own shape unpacking on the other side.
      const lists = await Promise.all(rs.map((r) => db.listCriteria(r.id)));
      setCriteria(Object.fromEntries(rs.map((r, i) => [r.id, lists[i]])));
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    void load();
  }, [load]);

  function received(doc: ClassDocument, result: Extraction) {
    setDraftDoc(doc);
    setDraftTitle(result.title || doc.title);
    setDraft(
      result.criteria.map((c, i) => ({
        key: `${i}`,
        label: c.label,
        weight: String(c.weight),
        max_score: String(c.max_score),
      })),
    );
  }

  function editDraft(key: string, patch: Partial<Draft>) {
    setDraft((rows) =>
      rows ? rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) : rows,
    );
  }

  async function confirm() {
    if (!draft) return;
    setSaving(true);
    try {
      const rows = draft
        .filter((r) => r.label.trim())
        .map((r) => ({
          label: r.label.trim(),
          weight: parseNumber(r.weight) ?? 0,
          // A component has to be out of something. 100 is the assumption the
          // extractor already makes when a document is silent, restated here
          // so a box someone cleared cannot write a zero the check constraint
          // would then reject on save.
          max_score: parseNumber(r.max_score) ?? 100,
        }));

      await db.createRubric({
        user_id: userId,
        class_id: classId,
        document_id: draftDoc?.id ?? null,
        title: draftTitle.trim() || "Rubric",
        criteria: rows,
      });
      setDraft(null);
      setDraftDoc(null);
      await load();
      toast("Rubric saved", "success");
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setSaving(false);
    }
  }

  function patchCriterion(
    rubricId: string,
    id: string,
    patch: Partial<RubricCriterion>,
  ) {
    const previous = criteria[rubricId] ?? [];
    setCriteria((all) => ({
      ...all,
      [rubricId]: previous.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
    void (async () => {
      try {
        await db.updateCriterion(id, patch);
      } catch (e) {
        setCriteria((all) => ({ ...all, [rubricId]: previous }));
        toast(message(e), "error");
      }
    })();
  }

  function removeCriterion(rubricId: string, c: RubricCriterion) {
    const previous = criteria[rubricId] ?? [];
    undoable({
      message: `Removed ${c.label}`,
      apply: () =>
        setCriteria((all) => ({
          ...all,
          [rubricId]: previous.filter((x) => x.id !== c.id),
        })),
      commit: () => db.deleteCriterion(c.id),
      revert: () => setCriteria((all) => ({ ...all, [rubricId]: previous })),
    });
  }

  async function addRow(rubricId: string) {
    try {
      const list = criteria[rubricId] ?? [];
      const saved = await db.addCriterion({
        user_id: userId,
        rubric_id: rubricId,
        label: "",
        weight: 0,
        max_score: 100,
        position: list.length,
      });
      setCriteria((all) => ({ ...all, [rubricId]: [...list, saved] }));
    } catch (e) {
      toast(message(e), "error");
    }
  }

  function removeRubric(r: Rubric) {
    const previous = rubrics;
    undoable({
      message: `Removed ${r.title}`,
      apply: () => setRubrics((prev) => prev.filter((x) => x.id !== r.id)),
      commit: () => db.deleteRubric(r.id),
      revert: () => setRubrics(previous),
    });
  }

  return (
    <div className="stack">
      <DocumentUpload
        classId={classId}
        userId={userId}
        kind="rubric"
        aiEnabled={aiEnabled}
        busy={draft !== null}
        onExtracted={received}
      />

      {draft && (
        <section className="panel">
          <h2>Check what it found</h2>
          <label className="grow">
            <span className="label">Name</span>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Rubric"
            />
          </label>

          {draft.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">No graded components found</p>
              <p className="muted small">
                Try the page with the assessment breakdown on it, or add the
                rows by hand after confirming.
              </p>
            </div>
          ) : (
            <ul className="list criteria-review">
              {draft.map((r) => (
                <li key={r.key}>
                  <input
                    className="grow"
                    value={r.label}
                    placeholder="Component"
                    onChange={(e) => editDraft(r.key, { label: e.target.value })}
                    aria-label="Component"
                  />
                  <label className="small">
                    <span className="label">Weight %</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={r.weight}
                      onChange={(e) => editDraft(r.key, { weight: e.target.value })}
                    />
                  </label>
                  <label className="small">
                    <span className="label">Out of</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={r.max_score}
                      onChange={(e) =>
                        editDraft(r.key, { max_score: e.target.value })
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="doc-row">
            <button onClick={() => void confirm()} disabled={saving}>
              {saving ? "Saving…" : "Confirm"}
            </button>
            <button
              className="link"
              onClick={() => {
                setDraft(null);
                setDraftDoc(null);
              }}
              disabled={saving}
            >
              Discard
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <section className="panel">
          <p className="muted small">Loading…</p>
        </section>
      ) : rubrics.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <p className="empty-title">No rubric yet</p>
            <p className="muted small">
              Upload the grading breakdown to pull the weights in.
            </p>
          </div>
        </section>
      ) : (
        rubrics.map((r) => (
          <RubricCard
            key={r.id}
            rubric={r}
            criteria={criteria[r.id] ?? []}
            onPatch={(id, patch) => patchCriterion(r.id, id, patch)}
            onRemoveRow={(c) => removeCriterion(r.id, c)}
            onAddRow={() => void addRow(r.id)}
            onRemove={() => removeRubric(r)}
          />
        ))
      )}
    </div>
  );
}

function RubricCard({
  rubric,
  criteria,
  onPatch,
  onRemoveRow,
  onAddRow,
  onRemove,
}: {
  rubric: Rubric;
  criteria: RubricCriterion[];
  onPatch: (id: string, patch: Partial<RubricCriterion>) => void;
  onRemoveRow: (c: RubricCriterion) => void;
  onAddRow: () => void;
  onRemove: () => void;
}) {
  const t = grades.totals(criteria);

  return (
    <section className="panel">
      <div className="doc-row">
        <h2 className="grow">{rubric.title}</h2>
        <button className="link danger" onClick={onRemove}>
          Remove rubric
        </button>
      </div>

      <ul className="list criteria-list">
        {criteria.map((c) => {
          const points = grades.earnedPoints(c);
          return (
            <li key={c.id} className="criterion-row">
              <input
                className="grow"
                value={c.label}
                placeholder="Component"
                onChange={(e) => onPatch(c.id, { label: e.target.value })}
                aria-label="Component"
              />
              <label className="small">
                <span className="label">Weight %</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={c.weight}
                  onChange={(e) =>
                    onPatch(c.id, { weight: parseNumber(e.target.value) ?? 0 })
                  }
                />
              </label>
              <label className="small">
                <span className="label">Score</span>
                <input
                  type="number"
                  inputMode="decimal"
                  // An empty box is ungraded, and stays empty. `?? ""` rather
                  // than `?? 0` is the entire reason this screen tells the
                  // truth in week six.
                  value={c.score ?? ""}
                  placeholder="—"
                  onChange={(e) =>
                    onPatch(c.id, { score: parseNumber(e.target.value) })
                  }
                />
              </label>
              <span className="muted small criterion-max">
                / {c.max_score}
              </span>
              <span className="criterion-points muted small">
                {points === null ? "—" : `${grades.formatPercent(points)} earned`}
              </span>
              <button
                className="link danger icon-btn"
                onClick={() => onRemoveRow(c)}
                aria-label={`Remove ${c.label || "component"}`}
                title="Remove"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <button className="link" onClick={onAddRow}>
        Add a component
      </button>

      <p className="grade-total">
        {t.percent === null ? (
          <span className="muted">Nothing marked yet</span>
        ) : (
          <>
            <strong>{grades.formatPercent(t.percent)}</strong>{" "}
            {/* The qualifier is not a footnote — it is what the number means.
                92% of the 30% that has been marked is a different claim from
                92% of the course, and only one of them is true in October. */}
            <span className="muted">
              of the {grades.formatPercent(t.gradedWeight)} graded so far
            </span>
          </>
        )}
      </p>

      {t.ungraded > 0 && (
        <p className="muted small">
          {t.ungraded} {t.ungraded === 1 ? "component" : "components"} ungraded, and
          left out of that total.
        </p>
      )}

      {criteria.length > 0 && !grades.weightsLookComplete(t.totalWeight) && (
        <p className="muted small">
          The weights add up to {grades.formatPercent(t.totalWeight)}, not 100% —
          a row may be missing from what was extracted.
        </p>
      )}
    </section>
  );
}

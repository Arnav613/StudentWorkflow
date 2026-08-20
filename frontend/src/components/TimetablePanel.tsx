import { useCallback, useEffect, useMemo, useState } from "react";
import * as db from "../lib/db";
import type { ClassDocument, ClassSession } from "../lib/types";
import { toast, undoable } from "../lib/toast";
import type { Extraction } from "../lib/api";
import { formatSessionDate, isoDate } from "../lib/schedule";
import DocumentUpload from "./DocumentUpload";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

/** A row in the review table: what the model said, before anyone agreed. */
type Draft = {
  key: string;
  on_date: string;
  topic: string;
  details: string;
  is_assessment: boolean;
};

/**
 * Timetable: the schedule a professor handed out, as this class's own term.
 *
 * The rows here are not tasks and never become tasks. A lecture is something
 * you attend, not something you complete — it has no status, never archives,
 * and never reaches the board or the workload forecast. That is a deliberate
 * reversal of PLAN.md's original phase 10 line: forty "read chapter three"
 * cards would bury the twelve that are real work, and a forecast that counted
 * lecture hours as hours owed would be wrong by a factor of four.
 *
 * What the schedule is for is the other direction. Once a class is linked to
 * its calendar lectures, the Week tab can look at Wednesday's block and say
 * what Wednesday is about — which is the only reason a timetable is worth
 * reading into a database at all.
 */
export default function TimetablePanel({
  classId,
  userId,
  aiEnabled,
}: {
  classId: string;
  userId: string;
  aiEnabled: boolean;
}) {
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * The extraction under review. Held here and nowhere else — no row, no
   * table, nothing that survives a reload.
   *
   * That is the whole design of the confirm step: a scanned handout is wrong
   * in ways only the person holding it can see, and they are holding it right
   * now. A queue you come back to on Thursday is a queue you approve without
   * the document in front of you, which is the failure the step exists to
   * prevent.
   */
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [draftDoc, setDraftDoc] = useState<ClassDocument | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await db.listClassSessions(classId));
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
    setDraft(
      result.sessions.map((s, i) => ({
        key: `${i}`,
        on_date: s.date,
        topic: s.topic,
        details: s.details,
        is_assessment: s.is_assessment,
      })),
    );
  }

  function editDraft(key: string, patch: Partial<Draft>) {
    setDraft((rows) =>
      rows ? rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) : rows,
    );
  }

  async function confirm() {
    if (!draft || !draftDoc) return;
    setSaving(true);
    try {
      // Rows emptied out in the review table are dropped rather than saved
      // blank: deleting the topic is how you say "this one is not real",
      // there being no other gesture for it in a table of text boxes.
      const rows = draft
        .filter((r) => r.topic.trim() && /^\d{4}-\d{2}-\d{2}$/.test(r.on_date))
        .map((r) => ({
          on_date: r.on_date,
          topic: r.topic.trim(),
          details: r.details.trim() || null,
          is_assessment: r.is_assessment,
        }));

      await db.replaceSessionsForDocument({
        user_id: userId,
        class_id: classId,
        document_id: draftDoc.id,
        rows,
      });
      setDraft(null);
      setDraftDoc(null);
      await load();
      toast(
        rows.length ? `Saved ${rows.length} sessions` : "Nothing was saved",
        "success",
      );
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setSaving(false);
    }
  }

  function removeSession(s: ClassSession) {
    const previous = sessions;
    undoable({
      message: `Removed ${s.topic || formatSessionDate(s.on_date)}`,
      apply: () => setSessions((prev) => prev.filter((x) => x.id !== s.id)),
      commit: () => db.deleteClassSession(s.id),
      revert: () => setSessions(previous),
    });
  }

  const today = isoDate(new Date());

  /**
   * The next session, and the one detail that makes this tab worth opening:
   * what is on in the next class.
   *
   * Today counts as ahead. A lecture at four this afternoon is the next class
   * right up until it happens, and an app that moved on from it at midnight
   * would be answering a question nobody asked.
   */
  const next = useMemo(
    () => sessions.find((s) => s.on_date >= today) ?? null,
    [sessions, today],
  );

  const past = sessions.filter((s) => s.on_date < today);
  const upcoming = sessions.filter((s) => s.on_date >= today);

  return (
    <div className="stack">
      {next && (
        <section className="panel">
          <h2>Next class</h2>
          <p className="next-class-date muted small">
            {formatSessionDate(next.on_date)}
            {next.is_assessment && <span className="tag">Assessment</span>}
          </p>
          <p className="next-class-topic">{next.topic}</p>
          {next.details && <p className="muted small">{next.details}</p>}
        </section>
      )}

      <DocumentUpload
        classId={classId}
        userId={userId}
        kind="timetable"
        aiEnabled={aiEnabled}
        busy={draft !== null}
        onExtracted={received}
      />

      {draft && (
        <section className="panel">
          <h2>Check what it found</h2>
          <p className="muted small">
            Nothing is saved until you press Confirm. Edit anything that is
            wrong; clear a topic to drop that row.
            {draftDoc && (
              <>
                {" "}
                Confirming replaces whatever <strong>{draftDoc.title}</strong>{" "}
                produced before — sessions from another document, and any you
                typed yourself, are left alone.
              </>
            )}
          </p>

          {draft.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">No dated rows in that document</p>
              <p className="muted small">
                A timetable needs dates to be read. Try the page with the
                schedule on it.
              </p>
            </div>
          ) : (
            <ul className="list session-review">
              {draft.map((r) => (
                <li key={r.key}>
                  <input
                    type="date"
                    value={r.on_date}
                    onChange={(e) => editDraft(r.key, { on_date: e.target.value })}
                    aria-label="Date"
                  />
                  <input
                    className="grow"
                    value={r.topic}
                    placeholder="Topic"
                    onChange={(e) => editDraft(r.key, { topic: e.target.value })}
                    aria-label="Topic"
                  />
                  <input
                    className="grow"
                    value={r.details}
                    placeholder="Readings, notes"
                    onChange={(e) => editDraft(r.key, { details: e.target.value })}
                    aria-label="Details"
                  />
                  <label className="small" title="A quiz, test or exam">
                    <input
                      type="checkbox"
                      checked={r.is_assessment}
                      onChange={(e) =>
                        editDraft(r.key, { is_assessment: e.target.checked })
                      }
                    />{" "}
                    Assessment
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

      <section className="panel">
        <h2>Schedule</h2>
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : sessions.length === 0 ? (
          <div className="empty-state">
            <p className="empty-title">No schedule yet</p>
            <p className="muted small">
              Upload the timetable your professor handed out and it will show
              here — and on the Week tab, against this class&rsquo;s lectures.
            </p>
          </div>
        ) : (
          <>
            <ul className="list session-list">
              {upcoming.map((s) => (
                <SessionRow key={s.id} session={s} onRemove={removeSession} />
              ))}
            </ul>
            {past.length > 0 && (
              <details className="session-past">
                {/* Folded away rather than deleted. Half a term of topics is
                    what you go back to when revising, and it is also the only
                    place to check whether the extraction got the early weeks
                    right. */}
                <summary className="muted small">
                  {past.length} earlier {past.length === 1 ? "session" : "sessions"}
                </summary>
                <ul className="list session-list">
                  {past.map((s) => (
                    <SessionRow key={s.id} session={s} onRemove={removeSession} past />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function SessionRow({
  session,
  onRemove,
  past = false,
}: {
  session: ClassSession;
  onRemove: (s: ClassSession) => void;
  past?: boolean;
}) {
  return (
    <li className={past ? "session-row is-past" : "session-row"}>
      <span className="session-date muted small">
        {formatSessionDate(session.on_date)}
      </span>
      <span className="grow">
        <span className="session-topic">
          {session.topic}
          {session.is_assessment && (
            <span className="tag" title="An assessment on the timetable">
              Assessment
            </span>
          )}
        </span>
        {session.details && (
          <span className="muted small session-details">{session.details}</span>
        )}
      </span>
      <button
        className="link danger icon-btn"
        onClick={() => onRemove(session)}
        aria-label={`Remove ${session.topic}`}
        title="Remove"
      >
        ×
      </button>
    </li>
  );
}

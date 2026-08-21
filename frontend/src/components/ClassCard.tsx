import type { Class, HealthTask, Task } from "../lib/types";
import {
  classHealth,
  formatDue,
  formatDueExact,
  formatLate,
  isOverdue,
  nextDue,
} from "../lib/board";

/**
 * A class, as a card you open.
 *
 * A rule of the class's own colour runs across the top — three pixels, not
 * the block it used to be. Finding a class by colour is faster than reading
 * four names, and a hairline is enough to do it.
 *
 * Under the name is the single next thing due, not a list. A card that tries
 * to show everything becomes a second board, and the board already exists one
 * tab over. The question this card answers is narrower: do I need to open
 * this today?
 *
 * Under that, how the class is going: on-time rate, anything overdue, and a
 * thin done ÷ total bar. Those come from the archive as well as the board,
 * which is the whole reason finished tasks are archived instead of deleted —
 * a term-long record is the only version of "on time" worth printing.
 */
export default function ClassCard({
  cls,
  tasks,
  history,
  noteCount,
  onOpen,
}: {
  cls: Class;
  tasks: Task[];
  /** Archived tasks for this class. Null while the archive is still loading. */
  history: HealthTask[] | null;
  noteCount: number | null;
  onOpen: () => void;
}) {
  const next = nextDue(tasks);
  const late = next ? isOverdue(next) : false;
  const todo = tasks.filter((t) => t.status === "todo").length;
  const doing = tasks.filter((t) => t.status === "doing").length;
  const health = classHealth([...tasks, ...(history ?? [])]);
  const percent = health.total ? Math.round((health.done / health.total) * 100) : 0;

  return (
    <button className={`class-card hue-${cls.color}`} onClick={onOpen}>
      <span className="class-card-band" aria-hidden="true" />

      <span className="class-card-body">
        <span className="class-card-head">
          <span className="class-card-name">{cls.name}</span>
          {cls.google_course_id && (
            <span className="tag" title="Imported from Google Classroom">
              GC
            </span>
          )}
        </span>

        <span className="class-card-prof muted small">{cls.professor}</span>

        <span className="class-card-next">
          {next ? (
            <>
              <span className="class-card-next-label muted small">Next up</span>
              <span className="class-card-next-title">{next.title}</span>
              <span
                className={`small ${late ? "error" : "muted"}`}
                title={formatDueExact(next.due_at)}
              >
                {late ? formatLate(next.due_at) : formatDue(next.due_at)}
              </span>
            </>
          ) : (
            <span className="muted small">Nothing due.</span>
          )}
        </span>

        {/* The bar is the class at a glance; the two figures beside it are
            what the bar cannot say — whether the finished half was finished
            on time, and whether anything is late right now. */}
        <span className="class-card-health">
          <span
            className="health-bar"
            role="img"
            aria-label={`${health.done} of ${health.total} done`}
          >
            <span className="health-fill" style={{ width: `${percent}%` }} />
          </span>
          <span className="class-card-stats small">
            <span className="muted">
              {/* A dash under five dated completions: two-for-two is 100%,
                  and 100% beside a real 78% invites a comparison the numbers
                  cannot carry. */}
              {health.onTimeRate === null
                ? "— on time"
                : `${Math.round(health.onTimeRate * 100)}% on time`}
            </span>
            {health.overdue > 0 && (
              <span className="error">{health.overdue} overdue</span>
            )}
          </span>
        </span>

        <span className="class-card-foot small muted">
          <span>{todo} to do</span>
          <span>{doing} doing</span>
          {noteCount !== null && (
            <span>
              {noteCount} note{noteCount === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

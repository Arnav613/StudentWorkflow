import type { Class, Task } from "../lib/types";
import { formatDue, formatDueExact, formatLate, isOverdue, nextDue } from "../lib/board";

/**
 * A class, as a card you open.
 *
 * The colour band is the class's own colour at full strength — the one place
 * in the app where a class colour is allowed to be loud, because this grid is
 * how you find a class, and finding it by colour is faster than reading four
 * names.
 *
 * Under the name is the single next thing due, not a list. A card that tries
 * to show everything becomes a second board, and the board already exists one
 * tab over. The question this card answers is narrower: do I need to open
 * this today?
 */
export default function ClassCard({
  cls,
  tasks,
  noteCount,
  onOpen,
}: {
  cls: Class;
  tasks: Task[];
  noteCount: number | null;
  onOpen: () => void;
}) {
  const next = nextDue(tasks);
  const late = next ? isOverdue(next) : false;
  const todo = tasks.filter((t) => t.status === "todo").length;
  const doing = tasks.filter((t) => t.status === "doing").length;

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

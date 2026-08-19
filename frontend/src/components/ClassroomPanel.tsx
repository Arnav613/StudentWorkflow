import type { Session } from "@supabase/supabase-js";
import { useClassroom } from "../hooks/useClassroom";
import type { SyncReport } from "../lib/api";

function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Only the lines with something to say. A row of zeroes is noise. */
function summary(r: SyncReport): string {
  const parts = [
    r.classes_created && `${r.classes_created} new class${r.classes_created === 1 ? "" : "es"}`,
    r.classes_linked && `${r.classes_linked} class${r.classes_linked === 1 ? "" : "es"} linked`,
    r.tasks_created && `${r.tasks_created} new task${r.tasks_created === 1 ? "" : "s"}`,
    r.tasks_adopted && `${r.tasks_adopted} matched to tasks you had already typed`,
    r.tasks_updated && `${r.tasks_updated} updated`,
    // Said out loud, because a card that moved on its own is the one change
    // the user did not make and cannot otherwise account for.
    r.tasks_auto_completed &&
      `${r.tasks_auto_completed} moved to Done — submitted on Classroom`,
    r.tasks_auto_reopened &&
      `${r.tasks_auto_reopened} back on the board — no longer submitted`,
    r.tasks_skipped_submitted &&
      `${r.tasks_skipped_submitted} already submitted, skipped`,
    // Named rather than silent: "why is my course missing" is the first
    // question a filtered-out course provokes. Courses you removed are the
    // exception — you already know, and repeating it back is just noise.
    r.courses_skipped_term &&
      `${r.courses_skipped_term} course${r.courses_skipped_term === 1 ? "" : "s"} from another term, skipped`,
  ].filter(Boolean);
  // Empty when nothing changed. It used to say "Everything was already up to
  // date", which was true and worth saying beside a button someone had just
  // pressed; appended to a line that now prints on every load it is only
  // noise. "Synced 2 min ago" already carries it.
  return parts.join(" · ");
}

/**
 * Connect Classroom, and the two things that can go wrong with it.
 *
 * There used to be a panel here permanently: a heading, a Disconnect button
 * and a status line, sitting under the class grid on every load of a working
 * connection. A connection that works needs no controls — it is not a feature
 * you operate, it is plumbing — and a box whose only button destroys it is a
 * box that can only ever be pressed by mistake. So once connected this
 * collapses to one muted line, and the panel comes back only when there is
 * something to do: connect for the first time, or reconnect.
 *
 * The banner is not a nicety: in Testing mode Google expires the refresh
 * token every seven days, so every user hits this weekly. Without it they
 * would see a board that has quietly stopped updating and no way to guess
 * why.
 */
export default function ClassroomPanel({
  session,
  onSynced,
}: {
  session: Session;
  onSynced: () => void;
}) {
  const { status, report, busy, error, connect } = useClassroom(
    session,
    onSynced,
  );

  const connected = status?.connected ?? false;
  const needsReconnect = status?.needs_reconnect ?? false;

  // Connected, working, nothing to report: one line saying when it last
  // heard from Google. Not nothing — a board that updates itself has to say
  // so somewhere, or the first missing assignment reads as a broken app
  // rather than a Classroom that has not posted it yet.
  if (connected && !needsReconnect) {
    return (
      <p className="muted small classroom-line">
        {busy ? (
          <>
            {busy}{" "}
            <span className="small">
              The first request of the day wakes the server and can take up to
              a minute.
            </span>
          </>
        ) : (
          <>
            Classroom synced {when(status?.last_success_at)}
            {report && summary(report) ? ` · ${summary(report)}` : ""}
            {status?.last_error ? ` · last attempt failed: ${status.last_error}` : ""}
            {error ? ` · ${error}` : ""}
            {/* Skipped courses and the like. Quiet, but never dropped: "why
                is my course missing" is the question they answer. */}
            {report?.warnings.map((w) => (
              <span key={w} className="classroom-warning">
                {w}
              </span>
            ))}
          </>
        )}
      </p>
    );
  }

  return (
    <section className="panel">
      <h2>Google Classroom</h2>

      {needsReconnect ? (
        <div className="banner">
          <strong>Reconnect Classroom.</strong>{" "}
          <span className="muted">
            Google expires this app&rsquo;s permission every seven days while it
            is unpublished. Your tasks and sign-in are untouched — only new
            coursework has stopped arriving.
          </span>
          <div className="row">
            <button onClick={connect} disabled={Boolean(busy)}>
              Reconnect
            </button>
          </div>
        </div>
      ) : (
        <>
          {!busy && (
            <p className="muted small">
              Import your courses and their deadlines. Read-only: this can see
              your courses and your own assignments, and can never write to
              Classroom or read anyone else&rsquo;s work.
            </p>
          )}
          <div className="row">
            <button onClick={connect} disabled={Boolean(busy)}>
              Connect Classroom
            </button>
          </div>
        </>
      )}

      {busy && (
        <p className="muted">
          {busy}{" "}
          <span className="small">
            The first request of the day wakes the server and can take up to a
            minute.
          </span>
        </p>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}

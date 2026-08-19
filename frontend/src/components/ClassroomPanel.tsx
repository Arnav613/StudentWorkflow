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
  return parts.length ? parts.join(" · ") : "Everything was already up to date.";
}

/**
 * Connect Classroom, sync, and the reconnect banner.
 *
 * The banner is built now rather than saved for polish because it is not a
 * nicety: in Testing mode Google expires the refresh token every seven days,
 * so every user hits this weekly. Without it they would see a board that has
 * quietly stopped updating and no way to guess why.
 */
export default function ClassroomPanel({
  session,
  onSynced,
}: {
  session: Session;
  onSynced: () => void;
}) {
  const { status, report, busy, error, connect, disconnect } = useClassroom(
    session,
    onSynced,
  );

  const connected = status?.connected ?? false;
  const needsReconnect = status?.needs_reconnect ?? false;

  return (
    <section className="panel">
      <h2>Google Classroom</h2>

      {needsReconnect && (
        <div className="banner">
          <strong>Reconnect Classroom.</strong>{" "}
          <span className="muted">
            Google expires this app&rsquo;s permission every seven days while it
            is unpublished. Your tasks and sign-in are untouched — only new
            coursework has stopped arriving.
          </span>
          <div className="row">
            <button onClick={connect}>Reconnect</button>
          </div>
        </div>
      )}

      {!connected && !busy && (
        <p className="muted small">
          Import your courses and their deadlines. Read-only: this can see your
          courses and your own assignments, and can never write to Classroom or
          read anyone else&rsquo;s work.
        </p>
      )}

      <div className="row">
        {!connected ? (
          <button onClick={connect} disabled={Boolean(busy)}>
            Connect Classroom
          </button>
        ) : (
          /* No Sync now. useClassroom already syncs on open when the last
             success is over half an hour old, and cron syncs in between, so
             the button did nothing a reload would not — while implying the
             board is only current because you pressed it. `sync` stays: the
             fresh-connect path still calls it. */
          <button onClick={disconnect} disabled={Boolean(busy)}>
            Disconnect
          </button>
        )}
      </div>

      {busy && (
        <p className="muted">
          {busy}{" "}
          <span className="small">
            The first request of the day wakes the server and can take up to a
            minute.
          </span>
        </p>
      )}

      {connected && !busy && (
        <p className="muted small">
          Last synced {when(status?.last_success_at)}
          {status?.last_error && !needsReconnect
            ? ` · last attempt failed: ${status.last_error}`
            : ""}
        </p>
      )}

      {report && !busy && <p className="ok">{summary(report)}</p>}

      {report?.warnings.length ? (
        <ul className="list small muted">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {error && <p className="error">{error}</p>}
    </section>
  );
}

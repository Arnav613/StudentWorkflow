import type { Session } from "@supabase/supabase-js";
import { useClassroom } from "../hooks/useClassroom";

/**
 * Connect Classroom, and the two things that can go wrong with it.
 *
 * A working connection renders nothing at all. It had a panel, then a status
 * line saying when it last heard from Google; both were reporting on plumbing.
 * The sync happens on every load and its result is the board itself — a new
 * assignment appearing is the status, and a line above it announcing that the
 * check ran is a second, weaker copy of the same news. What is left renders
 * only when there is something to do or something has gone wrong.
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
  const { status, busy, error, connect } = useClassroom(session, onSynced);

  // Nothing until the status is actually known. `connected` defaults to
  // false, so during the first round trip — which wakes a sleeping Render and
  // can take a second — the Connect panel was rendering for a moment on every
  // reload of an already-connected account, then vanishing. A box that
  // appears and leaves on its own is worse than a slightly later one: it
  // reads as a glitch, and for that second it says the opposite of the truth.
  //
  // An unreachable server is the exception. Then the status stays unknown for
  // good, and showing nothing would leave someone who has never connected
  // with no way in.
  if (!status && !error) return null;

  const connected = status?.connected ?? false;
  const needsReconnect = status?.needs_reconnect ?? false;
  // A live grant issued before the app asked for Calendar, announcements,
  // materials or Drive. Everything works; some of it works with less.
  const needsScopes = status?.needs_scopes ?? false;

  // Connected and working: nothing. The exception is a failure, which is
  // still said out loud — a sync that silently stopped is indistinguishable
  // from a Classroom with no new work in it, and those are very different
  // facts about your week.
  if (connected && !needsReconnect && !needsScopes) {
    const failure = error ?? status?.last_error;
    if (!failure || busy) return null;
    return (
      <p className="error small">Classroom sync failed: {failure}</p>
    );
  }

  return (
    <section className="panel">
      <h2>Google Classroom</h2>

      {needsReconnect || needsScopes ? (
        <div className="banner">
          {/* One button, two reasons to press it. Expiry means nothing is
              arriving; a missing scope means everything is arriving and one
              feature is dark. Saying "reconnect" for both and explaining
              neither would make the weekly prompt and the one-off prompt
              indistinguishable, and the weekly one is the one people learn to
              dismiss. */}
          {needsReconnect ? (
            <>
              <strong>Reconnect Classroom.</strong>{" "}
              <span className="muted">
                Google expires this app&rsquo;s permission every seven days
                while it is unpublished. Your tasks and sign-in are untouched —
                only new coursework has stopped arriving.
              </span>
            </>
          ) : (
            <>
              <strong>A few more permissions.</strong>{" "}
              <span className="muted">
                Asked for together, once, because Google issues a permission
                only at the moment you approve it — four prompts across four
                months would be four interruptions. The calendar, so the week
                planner can work around your lectures. Announcements and class
                materials, so a deadline a professor moved in a post reaches
                you, and so attached documents land in Docs on their own. And
                Drive, so those documents can be summarised. Every one is
                read-only, each can be unticked on the Google screen, and
                declining any of them costs you that feature and nothing else.
              </span>
            </>
          )}
          <div className="row">
            <button onClick={connect} disabled={Boolean(busy)}>
              {needsReconnect ? "Reconnect" : "Review permissions"}
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

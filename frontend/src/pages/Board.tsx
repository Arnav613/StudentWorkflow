import type { Session } from "@supabase/supabase-js";
import { signOut } from "../lib/supabase";
import { useData } from "../hooks/useData";
import ClassManager from "../components/ClassManager";
import TaskForm from "../components/TaskForm";
import TaskBoard from "../components/TaskBoard";
import ClassroomPanel from "../components/ClassroomPanel";

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string; classroomEnabled: boolean }
  | { kind: "error"; message: string };

/**
 * The page: classes, an add-task form, and the Do / Doing / Done board.
 *
 * Phase 03 replaced the flat task list with the board. Everything above it
 * stayed — creating a class and typing a deadline are still the two things
 * done most often, and burying them behind the board to make it look tidier
 * would trade the app's most common action for a screenshot.
 */
export default function Board({
  session,
  backend,
}: {
  session: Session;
  backend: BackendState;
}) {
  const store = useData(session.user.id);

  return (
    <div className="page">
      <header className="topbar">
        <strong>Student Dashboard</strong>
        <span className="muted">{session.user.email}</span>
        <button onClick={() => signOut()}>Sign out</button>
      </header>

      {/* The backend is not in the path of any CRUD here — that goes straight
          to Supabase. Only Classroom sync needs it, so a sleeping Render costs
          you fresh coursework, not your dashboard. Say exactly that. */}
      {backend.kind === "error" && (
        <p className="muted small">
          Sync server unreachable ({backend.message}). Your classes and tasks
          still work — only Classroom import is affected.
        </p>
      )}

      {store.loading ? (
        <p className="muted">Loading your dashboard…</p>
      ) : store.error ? (
        <div className="panel">
          <p className="error">{store.error}</p>
          <button onClick={() => store.refresh()}>Try again</button>
        </div>
      ) : (
        <main className="stack">
          <ClassManager store={store} />
          <TaskForm store={store} />
          <TaskBoard store={store} />
          {backend.kind === "ok" && backend.classroomEnabled && (
            <ClassroomPanel session={session} onSynced={store.refresh} />
          )}
        </main>
      )}
    </div>
  );
}

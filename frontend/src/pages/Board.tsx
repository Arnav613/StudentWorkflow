import type { Session } from "@supabase/supabase-js";
import { signOut } from "../lib/supabase";
import { useData } from "../hooks/useData";
import ClassManager from "../components/ClassManager";
import TaskForm from "../components/TaskForm";
import TaskList from "../components/TaskList";

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string }
  | { kind: "error"; message: string };

/**
 * Phase 01: classes and tasks by hand, as a flat list.
 * Phase 02 turns this into the draggable Do / Doing / Done board.
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
          to Supabase. This only reports whether the API is reachable, which
          matters from phase 05 on. A sleeping Render must not read as a
          broken dashboard. */}
      {backend.kind === "error" && (
        <p className="muted small">
          Background API unreachable ({backend.message}). Your tasks still work
          — nothing on this page depends on it yet.
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
          <TaskList store={store} />
        </main>
      )}
    </div>
  );
}

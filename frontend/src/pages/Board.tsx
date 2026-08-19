import { Suspense, lazy, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { signOut } from "../lib/supabase";
import { useData } from "../hooks/useData";
import ClassManager from "../components/ClassManager";
import TaskForm from "../components/TaskForm";
import TaskBoard from "../components/TaskBoard";
import ClassroomPanel from "../components/ClassroomPanel";

/*
 * The editor is by far the largest thing this app ships — bigger than the
 * whole rest of the bundle — and the board is what opens first every time.
 * Split here rather than tuning chunks in the build config: the boundary that
 * matters is a screen the user may never visit today, and that is a fact about
 * the app, not about Rollup.
 */
const NotesPanel = lazy(() => import("../components/NotesPanel"));

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string; classroomEnabled: boolean }
  | { kind: "error"; message: string };

type View = "board" | "notes";

/**
 * The page: classes, an add-task form, and the Do / Doing / Done board — plus,
 * since phase 05, the notebooks behind a second tab.
 *
 * Phase 03 replaced the flat task list with the board. Everything above it
 * stayed — creating a class and typing a deadline are still the two things
 * done most often, and burying them behind the board to make it look tidier
 * would trade the app's most common action for a screenshot.
 *
 * Two tabs and no router. The app has exactly two screens and one shared
 * store; a route table would add a dependency, a redirect on load, and a
 * second source of truth about which screen is up, and buy nothing back. It
 * costs one state hook to change later.
 */
export default function Board({
  session,
  backend,
}: {
  session: Session;
  backend: BackendState;
}) {
  const store = useData(session.user.id);
  const [view, setView] = useState<View>("board");

  return (
    <div className="page">
      <header className="topbar">
        <strong>Student Dashboard</strong>
        <nav className="tabs">
          <button
            className={`tab${view === "board" ? " current" : ""}`}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            className={`tab${view === "notes" ? " current" : ""}`}
            onClick={() => setView("notes")}
          >
            Notes
          </button>
        </nav>
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
          {view === "board" ? (
            <>
              <ClassManager store={store} />
              <TaskForm store={store} />
              <TaskBoard store={store} />
              {backend.kind === "ok" && backend.classroomEnabled && (
                <ClassroomPanel session={session} onSynced={store.refresh} />
              )}
            </>
          ) : (
            <Suspense fallback={<p className="muted">Loading the editor…</p>}>
              <NotesPanel store={store} />
            </Suspense>
          )}
        </main>
      )}
    </div>
  );
}

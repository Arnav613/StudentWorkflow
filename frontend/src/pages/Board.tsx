import { lazy, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { useData } from "../hooks/useData";
import ClassesPage from "./Classes";
import TodoPage from "./Todo";
import WeekPage from "./Week";
import NotesPage from "./Notes";
import ClassDetail from "./ClassDetail";
import AccountMenu from "../components/AccountMenu";
import Logo from "../components/Logo";
import { useTitle } from "../lib/title";
import { newUndoEpoch } from "../lib/toast";
import {
  BoardSkeleton,
  ClassGridSkeleton,
  WeekSkeleton,
} from "../components/Skeleton";

/*
 * The editor is by far the largest thing this app ships — bigger than the
 * whole rest of the bundle — and a class's Tasks tab is what opens first.
 * Split here rather than tuning chunks in the build config: the boundary that
 * matters is a screen the user may never visit today, and that is a fact about
 * the app, not about Rollup.
 */
const NotesPanel = lazy(() => import("../components/NotesPanel"));

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string; classroomEnabled: boolean; aiEnabled: boolean }
  | { kind: "error"; message: string };

/**
 * Where you are in the app.
 *
 * Two top-level places — the class grid and the board across every class —
 * plus one class opened to one of its three tabs.
 *
 * Still no router, and now it earns a second look, because a class page is a
 * place people will want to link to and press Back out of. It is mirrored
 * into `location.hash` below, which buys the back button and a shareable URL
 * for about fifteen lines, without a route table, a redirect on load, or a
 * second source of truth about which screen is up.
 */
export type View =
  | { kind: "classes" }
  | { kind: "todo" }
  | { kind: "week" }
  | { kind: "notes" }
  | { kind: "class"; id: string; tab: ClassTab };

export type ClassTab = "tasks" | "notes" | "docs" | "timetable" | "grades";

const CLASS_TABS: ClassTab[] = [
  "tasks",
  "notes",
  "docs",
  "timetable",
  "grades",
];

function viewToHash(v: View): string {
  if (v.kind === "classes") return "#/classes";
  if (v.kind === "todo") return "#/todo";
  if (v.kind === "week") return "#/week";
  if (v.kind === "notes") return "#/notes";
  return `#/class/${v.id}/${v.tab}`;
}

function hashToView(hash: string): View {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "todo") return { kind: "todo" };
  if (parts[0] === "week") return { kind: "week" };
  if (parts[0] === "notes") return { kind: "notes" };
  if (parts[0] === "class" && parts[1]) {
    const tab = CLASS_TABS.includes(parts[2] as ClassTab)
      ? (parts[2] as ClassTab)
      : "tasks";
    return { kind: "class", id: parts[1], tab };
  }
  return { kind: "classes" };
}

/**
 * The shell: a top bar, and one of four screens under it.
 *
 * Classes is home. The board moved out of it and onto its own tab, because
 * the two are different questions — "what am I taking" and "what do I do
 * next" — and the old page answered them by stacking one on top of the other
 * and making you scroll past the first to reach the second.
 */
export default function Board({
  session,
  backend,
}: {
  session: Session;
  backend: BackendState;
}) {
  const store = useData(session.user.id);
  const [view, setView] = useState<View>(() => hashToView(location.hash));

  // Back and forward. The hash is written by go() rather than by an effect on
  // `view`, so a navigation is one history entry and not two.
  useEffect(() => {
    const onPop = () => setView(hashToView(location.hash));
    window.addEventListener("hashchange", onPop);
    return () => window.removeEventListener("hashchange", onPop);
  }, []);

  // Ctrl+Z means "take back what I just did *here*". Leaving a page ends
  // that scope: an in-flight delete keeps its own Undo button, but the
  // keystroke no longer reaches back across a navigation to a row the new
  // page isn't showing. Keyed on `view` so back/forward counts too.
  useEffect(() => {
    newUndoEpoch();
  }, [view]);

  function go(next: View, replace = false) {
    const hash = viewToHash(next);
    if (replace) history.replaceState(null, "", hash);
    else if (location.hash !== hash) history.pushState(null, "", hash);
    setView(next);
  }

  // A class that no longer exists — deleted here, or a stale link — should
  // land on the grid rather than on an empty frame. Only once the store has
  // actually loaded, or every refresh would bounce off its own loading state.
  const openClass =
    view.kind === "class" ? store.classes.find((c) => c.id === view.id) : undefined;
  useEffect(() => {
    if (view.kind === "class" && !store.loading && !openClass) {
      go({ kind: "classes" }, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, store.loading, openClass]);

  const tab = view.kind === "class" ? "classes" : view.kind;

  const TOP_TAB_TITLE: Record<"classes" | "todo" | "week" | "notes", string> = {
    classes: "Classes",
    todo: "To do",
    week: "Week",
    notes: "Notes",
  };

  const TAB_LABEL: Record<ClassTab, string> = {
    tasks: "Tasks",
    notes: "Notes",
    docs: "Docs",
    timetable: "Timetable",
    grades: "Grades",
  };
  useTitle(
    view.kind === "class"
      ? [openClass?.name, view.tab === "tasks" ? null : TAB_LABEL[view.tab]]
      : [TOP_TAB_TITLE[view.kind]],
  );

  return (
    <>
      {/*
        The bar sits outside .page so its background and bottom rule reach
        both edges of the window. Inside, it inherited the page's 88rem cap
        and stopped short of the viewport on a wide screen — a floating strip
        with the desktop showing either side of it.
      */}
      <header className="topbar">
        <div className="topbar-inner">
          <button
            className="brand"
            onClick={() => go({ kind: "classes" })}
            aria-label="Student Dashboard — home"
          >
            <Logo />
            <span className="brand-word">Student Dashboard</span>
          </button>

          <nav className="tabs">
            <button
              className={`tab${tab === "classes" ? " current" : ""}`}
              onClick={() => go({ kind: "classes" })}
            >
              Classes
            </button>
            <button
              className={`tab${tab === "todo" ? " current" : ""}`}
              onClick={() => go({ kind: "todo" })}
            >
              To do
            </button>
            {/* Third and last. "What am I taking", "what is due", "when will I
                do it" — three questions, in the order a term asks them.

                There was a fourth, Forecast, drawing a bar chart of the
                fortnight ahead. It has gone, and not because it was wrong: it
                was the only screen telling the truth about how much work a
                week held, and it told it somewhere you could not touch
                anything. The Week is that chart now. */}
            <button
              className={`tab${tab === "week" ? " current" : ""}`}
              onClick={() => go({ kind: "week" })}
            >
              Week
            </button>
            {/* Fourth, and last of its kind. The three before it are the term
                as the term sees it — courses, deadlines, hours. This one is
                the term as you overhear it: the sentence a professor said on
                the way out that has no due date and will still matter in
                three weeks. It had nowhere to live, so it was either being
                filed as a task with an invented deadline or forgotten. */}
            <button
              className={`tab${tab === "notes" ? " current" : ""}`}
              onClick={() => go({ kind: "notes" })}
            >
              Notes
            </button>
          </nav>

          <span className="spacer" />
          <AccountMenu email={session.user.email ?? ""} />
        </div>
      </header>

      <div className="page">
      {/* The backend is not in the path of any CRUD here — that goes straight
          to Supabase. Only Classroom sync needs it, so a sleeping Render costs
          you fresh coursework, not your dashboard. Say exactly that. */}
      {backend.kind === "error" && (
        <p className="muted small notice">
          Sync server unreachable ({backend.message}). Your classes and tasks
          still work — only Classroom import is affected.
        </p>
      )}

      {store.loading ? (
        view.kind === "week" ? (
          <WeekSkeleton />
        ) : view.kind === "todo" ? (
          <BoardSkeleton />
        ) : view.kind === "notes" ? (
          // The pad loads its own rows and says so itself; a skeleton of the
          // class grid in front of it would be a shape it never becomes.
          <p className="muted">Opening your notes…</p>
        ) : (
          <ClassGridSkeleton />
        )
      ) : store.error ? (
        <div className="panel">
          <p className="error">{store.error}</p>
          <button onClick={() => store.refresh()}>Try again</button>
        </div>
      ) : view.kind === "todo" ? (
        <TodoPage store={store} onOpenClass={(id) => go({ kind: "class", id, tab: "tasks" })} />
      ) : view.kind === "week" ? (
        <WeekPage store={store} onOpenClass={(id) => go({ kind: "class", id, tab: "tasks" })} />
      ) : view.kind === "notes" ? (
        <NotesPage store={store} onOpenClass={(id) => go({ kind: "class", id, tab: "tasks" })} />
      ) : view.kind === "class" && openClass ? (
        <ClassDetail
          cls={openClass}
          tab={view.tab}
          store={store}
          onTab={(t) => go({ kind: "class", id: openClass.id, tab: t })}
          onBack={() => go({ kind: "classes" })}
          aiEnabled={backend.kind === "ok" && backend.aiEnabled}
          notes={NotesPanel}
        />
      ) : (
        <ClassesPage
          store={store}
          session={session}
          classroomEnabled={backend.kind === "ok" && backend.classroomEnabled}
          onOpen={(id) => go({ kind: "class", id, tab: "tasks" })}
        />
      )}
      </div>
    </>
  );
}

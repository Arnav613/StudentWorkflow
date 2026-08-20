import { Suspense, type ComponentType } from "react";
import * as db from "../lib/db";
import type { Class } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import type { ClassTab } from "./Board";
import { toast, undoable } from "../lib/toast";
import TaskBoard from "../components/TaskBoard";
import DocsPanel from "../components/DocsPanel";

const TABS: { id: ClassTab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "notes", label: "Notes" },
  { id: "docs", label: "Docs" },
];

/**
 * One class, opened.
 *
 * Everything that belongs to a course, in one place and behind three tabs:
 * the work, the writing, and the links. Before this, tasks lived on a global
 * board and notes lived behind a class picker on a different screen — the
 * same course scattered across two places, each of which made you re-state
 * which class you meant.
 */
export default function ClassDetail({
  cls,
  tab,
  store,
  onTab,
  onBack,
  aiEnabled,
  notes: NotesPanel,
}: {
  cls: Class;
  tab: ClassTab;
  store: DataStore;
  onTab: (t: ClassTab) => void;
  onBack: () => void;
  /**
   * Whether the deployment has a model at all. Passed down rather than
   * fetched here: /config is already read once at startup, and a second read
   * would be a second answer that could disagree with the first.
   */
  aiEnabled: boolean;
  notes: ComponentType<{ store: DataStore; classId?: string }>;
}) {
  // A store view scoped to this class. The board component is unchanged and
  // does not know it is being shown a subset — filtering here rather than
  // teaching it a classId keeps one board, not two that drift.
  const scoped: DataStore = {
    ...store,
    tasks: store.tasks.filter((t) => t.class_id === cls.id),
  };

  /**
   * Removing a class takes its tasks, notes and links with it — the foreign
   * keys cascade — and for an imported class tells sync never to bring the
   * course back.
   *
   * Undo rather than a confirm() box. The old version asked "are you sure?"
   * with a task count in it, which is the weakest kind of safety: it arrives
   * before you have seen the consequence, and the answer is always yes. This
   * shows you the consequence and gives you five seconds to disagree.
   */
  function remove() {
    const previous = store.classes;
    const count = store.tasks.filter((t) => t.class_id === cls.id).length;
    const detail = count ? ` and ${count} task${count === 1 ? "" : "s"}` : "";

    undoable({
      message: `Removed ${cls.name}${detail}`,
      apply: () => {
        store.setClasses((cs) => cs.filter((c) => c.id !== cls.id));
        onBack();
      },
      commit: async () => {
        await db.removeClass({ ...cls, user_id: store.userId });
        await store.refresh();
      },
      revert: () => store.setClasses(previous),
      onError: () => toast("The class is still there", "info"),
    });
  }

  return (
    <div className="stack">
      <nav className="crumbs">
        <button className="link" onClick={onBack}>
          ← Classes
        </button>
      </nav>

      <header className={`class-header hue-${cls.color}`}>
        <span className="class-header-band" aria-hidden="true" />
        <div className="class-header-body">
          <div className="grow">
            <h1>{cls.name}</h1>
            <p className="muted small">
              {[cls.professor, cls.meeting_info].filter(Boolean).join(" · ") ||
                "No professor or meeting time set"}
            </p>
          </div>
          {cls.google_course_id && (
            <span className="tag" title="Imported from Google Classroom">
              Classroom
            </span>
          )}
          <button className="link danger" onClick={remove}>
            Remove class
          </button>
        </div>

        <nav className="tabs tabs-underline">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? " current" : ""}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === "tasks" && <TaskBoard store={scoped} emptyFor={cls.name} />}

      {tab === "notes" && (
        <Suspense fallback={<p className="muted">Loading the editor…</p>}>
          <NotesPanel store={store} classId={cls.id} />
        </Suspense>
      )}

      {tab === "docs" && (
        <DocsPanel classId={cls.id} userId={store.userId} aiEnabled={aiEnabled} />
      )}
    </div>
  );
}

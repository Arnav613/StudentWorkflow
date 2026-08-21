import { useEffect, useState } from "react";
import type { DataStore } from "../hooks/useData";
import TaskForm from "../components/TaskForm";
import TaskBoard, { type BoardMode } from "../components/TaskBoard";
import ProposalsPanel from "../components/ProposalsPanel";

const MODE_KEY = "todo.mode";

/**
 * Which arrangement was up last time.
 *
 * Remembered, and remembered locally. Someone who reads this page by course
 * reads it by course every morning, and a toggle that resets on every visit is
 * a toggle they have to press every visit — which is the same as not having
 * it. It is not in the database because it is a fact about this browser and
 * this reader's habit, not about the term.
 */
function remembered(): BoardMode {
  try {
    return localStorage.getItem(MODE_KEY) === "class" ? "class" : "columns";
  } catch {
    // Private windows and blocked site data. A default is a perfectly good
    // answer here and an error banner would not be.
    return "columns";
  }
}

/**
 * To do: everything, from every class, on one board.
 *
 * This is the "what do I do next" screen, and it is deliberately not filtered
 * by class — a Tuesday does not arrive one course at a time. The per-class
 * view of the same tasks lives inside each class, on its Tasks tab.
 *
 * It can, however, be *read* one course at a time, which is a different
 * request and a newer one: the week eleven readings arrive from one module,
 * "what is Biology still asking of me" is a real question and three columns
 * mixing six courses cannot answer it. The toggle changes the arrangement and
 * nothing else. No task moves, no estimate changes, and the Week is drawn from
 * exactly the rows it was drawn from before it was pressed.
 */
export default function TodoPage({
  store,
  onOpenClass,
}: {
  store: DataStore;
  onOpenClass: (id: string) => void;
}) {
  const live = store.tasks.filter((t) => t.status !== "done").length;
  const [mode, setMode] = useState<BoardMode>(remembered);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // See `remembered`. Nothing is lost that was not already unavailable.
    }
  }, [mode]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>To do</h1>
          <p className="muted small">
            {live
              ? `${live} thing${live === 1 ? "" : "s"} on your plate across every class`
              : "Nothing outstanding. Add something below."}
          </p>
        </div>

        {/* Two words, not a dropdown. There are exactly two arrangements and
            there is no third coming — a select would hide half the answer
            behind a click to save a centimetre. */}
        <div className="seg" role="group" aria-label="Arrange the board">
          <button
            className={`seg-item${mode === "columns" ? " current" : ""}`}
            onClick={() => setMode("columns")}
            aria-pressed={mode === "columns"}
          >
            Board
          </button>
          <button
            className={`seg-item${mode === "class" ? " current" : ""}`}
            onClick={() => setMode("class")}
            aria-pressed={mode === "class"}
          >
            By class
          </button>
        </div>
      </div>

      {/* Above the form, and above the board. A deadline a professor moved is
          the most urgent thing on this page on the rare day it exists, and it
          renders nothing at all on every other day. */}
      <ProposalsPanel store={store} />

      <TaskBoard store={store} mode={mode} onOpenClass={onOpenClass} />
      <TaskForm store={store} />
    </div>
  );
}

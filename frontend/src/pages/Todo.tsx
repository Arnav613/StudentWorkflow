import type { DataStore } from "../hooks/useData";
import TaskForm from "../components/TaskForm";
import TaskBoard from "../components/TaskBoard";
import ProposalsPanel from "../components/ProposalsPanel";

/**
 * To do: everything, from every class, on one board.
 *
 * This is the "what do I do next" screen, and it is deliberately not filtered
 * by class — a Tuesday does not arrive one course at a time. The per-class
 * view of the same tasks lives inside each class, on its Tasks tab.
 */
export default function TodoPage({
  store,
  onOpenClass,
}: {
  store: DataStore;
  onOpenClass: (id: string) => void;
}) {
  const live = store.tasks.filter((t) => t.status !== "done").length;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>To do</h1>
        <p className="muted small">
          {live
            ? `${live} thing${live === 1 ? "" : "s"} on your plate across every class`
            : "Nothing outstanding. Add something below."}
        </p>
      </div>

      {/* Above the form, and above the board. A deadline a professor moved is
          the most urgent thing on this page on the rare day it exists, and it
          renders nothing at all on every other day. */}
      <ProposalsPanel store={store} />

      <TaskBoard store={store} onOpenClass={onOpenClass} />
      <TaskForm store={store} />
    </div>
  );
}

import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { TaskStatus } from "../lib/types";

/**
 * A column is a drop target and nothing more.
 *
 * There is no drop *position* within a column, because there is no such thing:
 * a column sorts by due date, so a card lands where its deadline puts it, not
 * where the cursor was released. Pretending otherwise — an insertion line that
 * the sort then overrules — would be a lie told in animation.
 */
export default function BoardColumn({
  status,
  label,
  count,
  children,
  empty,
}: {
  status: TaskStatus;
  label: string;
  count: number;
  children: ReactNode;
  empty: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      className={`column column-${status} ${isOver ? "over" : ""}`}
      aria-label={label}
    >
      <h2>
        {label} <span className="count">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="list cards">{children}</ul>
      )}
    </section>
  );
}

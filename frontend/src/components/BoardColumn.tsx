import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { TaskStatus } from "../lib/types";

/**
 * A column is a drop target, and since migration 0016 it is a drop target with
 * an opinion about where.
 *
 * It used to be the only one: a column sorted itself by due date, so a card
 * landed where its deadline put it and an insertion line would have been a lie
 * told in animation. Now the order is whatever a hand made it, so the cards
 * themselves are the precise targets — see TaskCard — and this is what is left
 * over. Bare column space means the end of the column, and out of any group.
 * Which makes it the way out of a group, and the reason it is padded rather
 * than shrink-wrapped around the cards.
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
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });

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

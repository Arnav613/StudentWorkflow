import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { Class, Task } from "../lib/types";
import {
  daysUntilArchive,
  formatDue,
  formatDueExact,
  formatLate,
  isOverdue,
} from "../lib/board";
import { formatEstimate } from "../lib/schedule";
import { isSelectClick, type SelectModifiers } from "../hooks/useSelection";

/** Which side of this card a drop would land on, while one is being dragged. */
export type DropEdge = "before" | "after";

/**
 * One card on the board.
 *
 * The whole card is the drag handle rather than a grip in the corner — the
 * gesture people expect from a board is picking the card up. That would
 * normally swallow the buttons inside it, so the sensor in TaskBoard only
 * starts a drag after a few pixels of movement; a click stays a click.
 *
 * It is also a drop *target*, which it did not used to be. A column no longer
 * sorts itself, so where in the column a card lands is now a real question
 * with a real answer, and the only honest way to ask it is against the cards
 * already there: the line drawn above or below this one is exactly where the
 * card will be when the pointer is released.
 *
 * Everything editable lives in the dialog Open raises. The card used to unfold
 * a panel in place, which pushed the rest of the column down and left you
 * editing a field that had just moved.
 */
export default function TaskCard({
  task,
  cls,
  onOpen,
  onOpenClass,
  selected = false,
  onSelect,
  dropEdge,
}: {
  task: Task;
  cls: Class | null;
  onOpen: (task: Task) => void;
  /** Set on the all-tasks board, absent inside a class — where it would
      only ever navigate to the page you are already on. */
  onOpenClass?: (id: string) => void;
  selected?: boolean;
  /** Ctrl or shift came down on this card. Absent where selection is off. */
  onSelect?: (e: SelectModifiers) => void;
  dropEdge?: DropEdge;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  // The same id in both roles, which dnd-kit is happy with and which every
  // sortable list is built on: the thing you can pick up is the thing you can
  // drop next to. The data rides along so the board can answer "which column,
  // which group" from the drop event alone, without a second lookup.
  const { setNodeRef: setDropRef } = useDroppable({
    id: task.id,
    data: { status: task.status, groupId: task.group_id },
  });

  const overdue = isOverdue(task);
  const archiveIn = daysUntilArchive(task);

  /*
   * A modified click is a selection and stops being anything else.
   *
   * Caught on the way down, before dnd-kit's own pointerdown listener sees it,
   * because the alternative is a ctrl-click that selects the card *and* picks
   * it up. `preventDefault` is there for the shift-click, which browsers
   * otherwise answer by selecting the text between two cards.
   */
  function onPointerDownCapture(e: React.PointerEvent) {
    if (!onSelect || !isSelectClick(e)) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(e);
  }

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        setDropRef(node);
      }}
      {...listeners}
      {...attributes}
      onPointerDownCapture={onPointerDownCapture}
      aria-selected={onSelect ? selected : undefined}
      className={`card ${cls ? `hue-${cls.color}` : "hue-none"} ${
        isDragging ? "dragging" : ""
      } ${overdue ? "overdue" : ""}${selected ? " selected" : ""}${
        dropEdge ? ` drop-${dropEdge}` : ""
      }`}
    >
      <div className="row">
        <span
          className={`grow card-title ${task.status === "done" ? "struck" : ""}`}
        >
          {task.title}
        </span>
        <button className="link" onClick={() => onOpen(task)}>
          Open
        </button>
      </div>

      <div className="row card-meta">
        <span
          className={overdue ? "error" : "muted"}
          title={formatDueExact(task.due_at)}
        >
          {overdue ? formatLate(task.due_at) : formatDue(task.due_at)}
        </span>

        {cls &&
          (onOpenClass ? (
            <button
              className="tag tag-hue tag-button"
              onClick={() => onOpenClass(cls.id)}
              title={`Open ${cls.name}`}
            >
              <span className="dot" />
              {cls.name}
            </button>
          ) : (
            <span className="tag tag-hue">
              <span className="dot" />
              {cls.name}
            </span>
          ))}

        {/*
          Beside the due chip, because "due Thursday" and "takes two hours"
          are one thought. Absent rather than guessed here: the class-median
          fallback belongs to the planner, which shows its guesses in italics
          on the Week tab — a made-up number sitting on a card in the same
          type as a real one is exactly how an estimate stops meaning
          anything.
        */}
        {task.estimate_minutes && (
          <span className="muted" title="Your estimate">
            {formatEstimate(task.estimate_minutes)}
          </span>
        )}

        {task.source === "classroom" && <span className="tag">Classroom</span>}

        {/* The promise phase 04 has to keep: a card that moved itself says so,
            and stops saying so the moment you move it back by hand. */}
        {task.auto_completed && !task.status_overridden && (
          <span className="tag">Marked automatically</span>
        )}

        {archiveIn !== null && (
          <span className="muted">
            {archiveIn === 0 ? "Archives today" : `Archives in ${archiveIn}d`}
          </span>
        )}
      </div>
    </li>
  );
}

import { useEffect, useState } from "react";
import * as db from "../lib/db";
import type { ChecklistItem } from "../lib/types";

/**
 * Checklist inside a task. Always hand-added, never generated.
 *
 * Loaded per task on expand rather than with the main task list — most tasks
 * have no checklist, and fetching every item for every task to render a
 * collapsed row is wasted work.
 */
export default function ChecklistEditor({
  taskId,
  userId,
}: {
  taskId: string;
  userId: string;
}) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    db.listChecklistItems(taskId)
      .then(setItems)
      .finally(() => setLoading(false));
  }, [taskId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    const created = await db.createChecklistItem({
      user_id: userId,
      task_id: taskId,
      label: label.trim(),
      // Append. Gaps are fine — position is a sort key, not an index.
      position: items.length ? items[items.length - 1].position + 1 : 0,
    });
    setItems((prev) => [...prev, created]);
    setLabel("");
  }

  async function toggle(item: ChecklistItem) {
    const updated = await db.updateChecklistItem(item.id, { done: !item.done });
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
  }

  async function remove(item: ChecklistItem) {
    await db.deleteChecklistItem(item.id);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  if (loading) return <p className="muted small">Loading checklist…</p>;

  const done = items.filter((i) => i.done).length;

  return (
    <div className="checklist">
      {items.length > 0 && (
        <p className="muted small">
          {done} of {items.length} done
        </p>
      )}
      <ul className="list">
        {items.map((item) => (
          <li key={item.id}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => toggle(item)}
            />
            <span className={`grow ${item.done ? "struck" : ""}`}>{item.label}</span>
            <button className="link" onClick={() => remove(item)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={add}>
        <input
          className="grow"
          placeholder="Add a step"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button disabled={!label.trim()}>Add</button>
      </form>
    </div>
  );
}

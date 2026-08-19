import { useState } from "react";
import * as db from "../lib/db";
import type { DataStore } from "../hooks/useData";

/**
 * Adding a task by hand. Title is the only required field.
 *
 * A task does not need a class — class_id stays null rather than forcing
 * everything into a Miscellaneous bucket. Laundry and club meetings are real
 * tasks and they belong to no course.
 */
export default function TaskForm({ store }: { store: DataStore }) {
  const { classes, refresh, userId } = store;
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [classId, setClassId] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await db.createTask({
        user_id: userId,
        title: title.trim(),
        description: description.trim() || null,
        // datetime-local yields wall-clock text with no zone. new Date() reads
        // it as local time, which is what the user typed, and toISOString
        // hands Postgres proper UTC for the timestamptz column.
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        class_id: classId || null,
      });
      setTitle("");
      setDueAt("");
      setDescription("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add task");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Add a task</h2>
      <form className="stack" onSubmit={submit}>
        <input
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <div className="row">
          <label className="grow">
            <span className="label">Due</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </label>
          <label className="grow">
            <span className="label">Class</span>
            <select value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">No class</option>
              {classes
                .filter((c) => !c.hidden)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <textarea
          placeholder="Notes (optional)"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button disabled={busy || !title.trim()}>
          {busy ? "Adding…" : "Add task"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}

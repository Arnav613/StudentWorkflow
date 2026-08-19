import { useState } from "react";
import * as db from "../lib/db";
import { toast } from "../lib/toast";
import DatePicker from "./DatePicker";
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
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [classId, setClassId] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await db.createTask({
        user_id: userId,
        title: title.trim(),
        description: description.trim() || null,
        due_at: dueAtFrom(date, time),
        class_id: classId || null,
      });
      toast("Task added", "success");
      setTitle("");
      setDate("");
      setTime("");
      setDescription("");
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add task", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Add a task</h2>
      <form className="task-form" onSubmit={submit}>
        <div className="field-title">
          <input
            placeholder="What needs doing?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <label className="field-notes">
          <span className="label">Notes (optional)</span>
          <input
            placeholder="Anything worth remembering"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {/* A div, not a label: the control is a button, and a label wrapping
            one hijacks its click. */}
        <div className="field">
          <span className="label">Due</span>
          <DatePicker
            value={date}
            onChange={(next) => {
              setDate(next);
              // Clearing the date clears the time with it. The time input is
              // disabled without a date, so a stray value left behind would
              // be unreachable and would reappear on the next date chosen.
              if (!next) setTime("");
            }}
          />
        </div>
        <label>
          <span className="label">Time (optional)</span>
          <input
            type="time"
            value={time}
            disabled={!date}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <label>
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
        <div className="field-submit">
          <button disabled={busy || !title.trim()}>
            {busy ? "Adding…" : "Add task"}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * A date, and a time only if one was actually chosen.
 *
 * Split into two inputs rather than one datetime-local, because almost every
 * deadline a student types is a day, not an instant, and datetime-local
 * refuses to submit a date without also being given a clock. The old control
 * therefore made everyone invent a time, and the invented value then appeared
 * on every card as an authoritative-looking "12:00 AM".
 *
 * Empty time means midnight, which is what a whole-day deadline means: due by
 * the end of that day, and overdue the moment the next one starts. formatDue
 * knows to print no clock for exactly this value.
 *
 * Built as local wall-clock text and handed to `new Date`, which reads it in
 * the user's own zone; toISOString then gives Postgres proper UTC for the
 * timestamptz column.
 */
function dueAtFrom(date: string, time: string): string | null {
  if (!date) return null;
  return new Date(`${date}T${time || "00:00"}`).toISOString();
}

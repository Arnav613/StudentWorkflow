import { useState } from "react";
import * as db from "../lib/db";
import { toast } from "../lib/toast";
import DatePicker from "./DatePicker";
import ClassPicker from "./ClassPicker";
import TimePicker from "./TimePicker";
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
  const [estimate, setEstimate] = useState("");
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
        estimate_minutes: estimateFrom(estimate),
      });
      toast("Task added", "success");
      setTitle("");
      setDate("");
      setTime("");
      setDescription("");
      setEstimate("");
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
        <div className="field">
          <span className="label">Time (optional)</span>
          <TimePicker value={time} disabled={!date} onChange={setTime} />
        </div>
        {/*
          Optional, and left blank far more often than not. An unestimated
          task is planned against its class's median and says so in italics on
          the card — which is the honest version of a guess, and better than a
          required field that teaches everyone to type 60.
        */}
        <label className="field">
          <span className="label">Takes about (optional)</span>
          <span className="estimate-field">
            <input
              type="number"
              min={5}
              max={960}
              step={5}
              inputMode="numeric"
              placeholder="—"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
            />
            <span className="muted small">min</span>
          </span>
        </label>
        <div className="field">
          <span className="label">Class</span>
          <ClassPicker
            classes={classes.filter((c) => !c.hidden)}
            value={classId}
            onChange={setClassId}
          />
        </div>
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
/**
 * Minutes, or null for unestimated — never zero.
 *
 * The difference matters all the way down to the check constraint in
 * migration 0005: null means "I have not said", which the planner answers
 * with a visible guess, and zero would mean "this takes no time", which it
 * would answer by scheduling nothing and then losing the afternoon.
 */
function estimateFrom(raw: string): number | null {
  const n = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(960, Math.round(n));
}

function dueAtFrom(date: string, time: string): string | null {
  if (!date) return null;
  return new Date(`${date}T${time || "00:00"}`).toISOString();
}

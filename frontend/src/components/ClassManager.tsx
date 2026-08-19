import { useState } from "react";
import * as db from "../lib/db";
import { CLASS_COLORS } from "../lib/types";
import type { Class } from "../lib/types";
import type { DataStore } from "../hooks/useData";

export default function ClassManager({ store }: { store: DataStore }) {
  const { classes, tasks, refresh, userId } = store;
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(CLASS_COLORS[0]);
  const [professor, setProfessor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await db.createClass({
        user_id: userId,
        name: name.trim(),
        color,
        professor: professor.trim() || null,
      });
      setName("");
      setProfessor("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add class");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Removing a class takes its tasks with it and, for an imported class,
   * tells sync never to bring the course back.
   *
   * Confirmed rather than undoable: an undo would have to resurrect deleted
   * tasks, and the honest version of that is not deleting them in the first
   * place. The count is in the prompt because "3 tasks" is the part that
   * changes someone's mind — this dialog is the only warning there is.
   */
  async function remove(c: Class) {
    const count = tasks.filter((t) => t.class_id === c.id).length;
    const consequence = count
      ? `\n\n${count} task${count === 1 ? "" : "s"} will be deleted with it.`
      : "";
    const willReturn = c.google_course_id
      ? "\n\nIt will not be imported from Classroom again."
      : "";

    if (!confirm(`Remove ${c.name}?${consequence}${willReturn}`)) return;

    setBusy(true);
    setError(null);
    try {
      await db.removeClass({ ...c, user_id: userId });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove class");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Classes</h2>

      <form className="row" onSubmit={add}>
        <input
          placeholder="Class name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          placeholder="Professor (optional)"
          value={professor}
          onChange={(e) => setProfessor(e.target.value)}
        />
        <select value={color} onChange={(e) => setColor(e.target.value)}>
          {CLASS_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button disabled={busy || !name.trim()}>Add</button>
      </form>

      {error && <p className="error">{error}</p>}

      {classes.length === 0 ? (
        <p className="muted">No classes yet. Add the ones you are taking.</p>
      ) : (
        <ul className="list">
          {classes.map((c) => (
            <li key={c.id}>
              <span className={`dot dot-${c.color}`} />
              <span className="grow">
                {c.name}
                {c.professor && <span className="muted"> · {c.professor}</span>}
              </span>
              {c.google_course_id && <span className="tag dim">Classroom</span>}
              <button className="link" disabled={busy} onClick={() => remove(c)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

    </section>
  );
}

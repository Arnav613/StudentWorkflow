import { useState } from "react";
import * as db from "../lib/db";
import { CLASS_COLORS } from "../lib/types";
import type { Class } from "../lib/types";
import type { DataStore } from "../hooks/useData";

export default function ClassManager({ store }: { store: DataStore }) {
  const { classes, refresh, userId } = store;
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(CLASS_COLORS[0]);
  const [professor, setProfessor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const visible = classes.filter((c) => showHidden || !c.hidden);

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

  async function toggleHidden(c: Class) {
    await db.setClassHidden(c.id, !c.hidden);
    await refresh();
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

      {visible.length === 0 ? (
        <p className="muted">No classes yet. Add the ones you are taking.</p>
      ) : (
        <ul className="list">
          {visible.map((c) => (
            <li key={c.id} className={c.hidden ? "dim" : ""}>
              <span className={`dot dot-${c.color}`} />
              <span className="grow">
                {c.name}
                {c.professor && <span className="muted"> · {c.professor}</span>}
              </span>
              <button className="link" onClick={() => toggleHidden(c)}>
                {c.hidden ? "Unhide" : "Hide"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {classes.some((c) => c.hidden) && (
        <button className="link" onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? "Hide archived classes" : "Show hidden classes"}
        </button>
      )}
    </section>
  );
}

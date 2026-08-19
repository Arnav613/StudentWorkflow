import { useCallback, useEffect, useState } from "react";
import * as notesApi from "../lib/notes";
import type { Class, Note } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import NoteEditor from "./NoteEditor";

type NoteSummary = Pick<Note, "id" | "class_id" | "title" | "updated_at">;

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * Notes: pick a class, pick a note, write.
 *
 * A notebook per class and nothing else — notes never attach to an individual
 * task. A task is a deadline that comes and goes; a lecture note outlives the
 * assignment that prompted it, and hanging notes off tasks would send them to
 * the archive along with the work.
 */
export default function NotesPanel({
  store,
  classId: fixedClassId,
}: {
  store: DataStore;
  /**
   * Set when this is a class's own Notes tab. The picker disappears: the
   * page already says which class you are in, and offering to switch course
   * from inside one is how you end up writing Tuesday's lecture into
   * Thursday's notebook.
   */
  classId?: string;
}) {
  const { classes, userId } = store;
  const visible = classes.filter((c) => !c.hidden);

  const [pickedClassId, setPickedClassId] = useState<string | null>(null);
  const classId = fixedClassId ?? pickedClassId;
  const setClassId = setPickedClassId;
  const [list, setList] = useState<NoteSummary[]>([]);
  const [openNote, setOpenNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Land on a class rather than an empty frame asking the user to choose one.
  // Keyed on the id and not the filtered array, which is a fresh object every
  // render and would re-run this effect forever.
  const firstClassId = visible[0]?.id;
  useEffect(() => {
    if (!fixedClassId && classId === null && firstClassId) setClassId(firstClassId);
  }, [fixedClassId, classId, firstClassId]);

  const loadList = useCallback(async (cid: string) => {
    setLoading(true);
    setError(null);
    try {
      setList(await notesApi.listNotes(cid));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!classId) return;
    setOpenNote(null);
    void loadList(classId);
  }, [classId, loadList]);

  /**
   * Opening a note is the only place the block tree is fetched. The list
   * carries titles and dates; a semester of documents is megabytes, and
   * loading them all to render a sidebar would make the first open of the day
   * the slowest thing in the app.
   */
  async function open(id: string) {
    setError(null);
    try {
      setOpenNote(await notesApi.getNote(id));
    } catch (e) {
      setError(message(e));
    }
  }

  async function create() {
    if (!classId) return;
    setError(null);
    try {
      const note = await notesApi.createNote({ user_id: userId, class_id: classId });
      setList((prev) => [note, ...prev]);
      setOpenNote(note);
    } catch (e) {
      setError(message(e));
    }
  }

  // Saves come back up from the editor rather than triggering a refetch: the
  // only fields the sidebar shows are the two the save just returned, and
  // re-reading the list on every autosave would put a query behind every
  // sentence typed.
  const onSaved = useCallback(
    (patch: { id: string; title: string; updated_at: string }) =>
      setList((prev) =>
        prev.map((n) =>
          n.id === patch.id ? { ...n, title: patch.title, updated_at: patch.updated_at } : n,
        ),
      ),
    [],
  );

  const onDeleted = useCallback((id: string) => {
    setList((prev) => prev.filter((n) => n.id !== id));
    setOpenNote(null);
  }, []);

  if (!visible.length) {
    return (
      <section className="panel">
        <h2>Notes</h2>
        <p className="muted">
          Notes live in a class notebook. Add a class on the board first.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="row panel-head">
        <h2 className="grow">Notes</h2>
        {!fixedClassId && (
          <ClassPicker classes={visible} value={classId} onChange={setClassId} />
        )}
        <button className="btn-quiet" onClick={create} disabled={!classId}>
          New note
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="notebook">
        <aside className="notebook-list">
          {loading ? (
            <p className="muted small">Loading…</p>
          ) : list.length === 0 ? (
            <p className="muted small">No notes in this class yet.</p>
          ) : (
            <ul className="list">
              {list.map((n) => (
                <li key={n.id}>
                  <button
                    className={`note-item grow${openNote?.id === n.id ? " current" : ""}`}
                    onClick={() => open(n.id)}
                  >
                    <span className="grow">{n.title || "Untitled"}</span>
                    <span className="muted small">{when(n.updated_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="notebook-page">
          {openNote ? (
            // Keyed by id: switching notes builds a new editor rather than
            // swapping a document under a live one, which would carry undo
            // history across notes.
            <NoteEditor
              key={openNote.id}
              note={openNote}
              onSaved={onSaved}
              onDeleted={onDeleted}
            />
          ) : (
            <p className="empty-page">Pick a note, or start a new one.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ClassPicker({
  classes,
  value,
  onChange,
}: {
  classes: Class[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {classes.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

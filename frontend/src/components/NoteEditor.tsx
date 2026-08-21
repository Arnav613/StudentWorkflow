import { useCallback, useEffect, useRef, useState } from "react";
import type { PartialBlock } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
// The type stack is set once in main.tsx and index.html — app-wide, not just
// inside the editor.
import "@blocknote/mantine/style.css";
import * as notes from "../lib/notes";
import type { Note } from "../lib/types";
import { useAutosave } from "../hooks/useAutosave";
import type { SaveState } from "../hooks/useAutosave";

/**
 * One note, open.
 *
 * Mounted with `key={note.id}` by the panel above, so switching notes builds a
 * fresh editor rather than swapping a document underneath a live one.
 * BlockNote takes `initialContent` once and owns the document from then on;
 * feeding it a new note through props would leave undo history from the
 * previous note attached to this one.
 */
export default function NoteEditor({
  note,
  onSaved,
  onDeleted,
}: {
  note: Note;
  onSaved: (patch: { id: string; title: string; updated_at: string }) => void;
  onDeleted: (id: string) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [busy, setBusy] = useState(false);

  // Read inside the save closure rather than captured: the autosave callback
  // outlives any single render, and a stale title would overwrite a new one.
  const titleRef = useRef(title);
  titleRef.current = title;

  const save = useCallback(
    async (payload: { title: string; content: unknown[] }) => {
      const saved = await notes.updateNote(note.id, payload);
      onSaved({ id: saved.id, title: saved.title, updated_at: saved.updated_at });
    },
    [note.id, onSaved],
  );

  const autosave = useAutosave(save);

  const editor = useCreateBlockNote({
    // An empty array is not a valid document — BlockNote wants at least one
    // block — so a brand new note passes undefined and gets its own empty
    // paragraph.
    initialContent: note.content.length
      ? (note.content as PartialBlock[])
      : undefined,

    /**
     * Images land in Storage and the *path* goes into the document. See
     * lib/notes: the bucket is private, so URLs are signed at render time and
     * expire; writing one into the block tree would rot.
     */
    uploadFile: (file: File) => notes.uploadNoteImage(note.user_id, note.id, file),
    resolveFileUrl: notes.resolveNoteImage,
  });

  // Flush before the browser leaves the page, and whenever this note closes.
  const flush = autosave.flush;
  useEffect(() => () => void flush(), [flush]);

  async function remove() {
    if (!confirm(`Delete "${title || "Untitled"}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await notes.deleteNote(note);
      onDeleted(note.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="note-editor">
      <div className="row note-editor-head">
        <input
          className="note-title grow"
          value={title}
          placeholder="Untitled"
          onChange={(e) => {
            setTitle(e.target.value);
            autosave.queue({ title: e.target.value, content: editor.document });
          }}
        />
        <SaveIndicator state={autosave.state} error={autosave.error} />
        <button className="link danger" disabled={busy} onClick={remove}>
          Delete
        </button>
      </div>

      <BlockNoteView
        editor={editor}
        onChange={() =>
          autosave.queue({ title: titleRef.current, content: editor.document })
        }
      />
    </div>
  );
}

/**
 * Four words, and the only one that matters is the failure.
 *
 * "Saving…" is deliberately not shown as a spinner or a blocking state: the
 * document is already in the editor and the user should keep typing through
 * it. An error, by contrast, has to be loud — it is the one case where what is
 * on screen is not what is in the database.
 */
function SaveIndicator({
  state,
  error,
}: {
  state: SaveState;
  error: string | null;
}) {
  if (state === "error") {
    return (
      <span className="small error" role="alert">
        Not saved — {error ?? "try again"}
      </span>
    );
  }
  const label =
    state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved" : state === "saved" ? "Saved" : "";
  return <span className="small muted">{label}</span>;
}

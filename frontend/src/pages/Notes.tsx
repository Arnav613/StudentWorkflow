import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as db from "../lib/db";
import type { Class, ScratchLine, Task } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import { useAutosave } from "../hooks/useAutosave";
import { errorText, toast } from "../lib/toast";
import ClassPicker from "../components/ClassPicker";

/**
 * Notes: one long page you type into, and nothing else.
 *
 * The fourth tab exists because the app had exactly one shape for a thing you
 * have to remember — a task — and a task is far too heavy for most of what a
 * term actually throws at you. "Prof said the midterm is open book." "Lab moved
 * to B204." Neither has a deadline, neither takes an hour, and filing either
 * one as a task means inventing both and then looking at them on the board
 * every morning until you delete them.
 *
 * So: a page. Not a wall of sticky notes, not a second inbox with checkboxes —
 * those are both task lists wearing a different hat, and the point of this
 * screen is that it is not a task list. You type, it saves, it is there
 * tomorrow.
 *
 * What it does have is a marker per line, which is the one thing a plain
 * textarea cannot do. A line can say which class it is about, and a line can
 * be promoted into a real task on the board the moment it turns out to have
 * been one after all. That is why this is stored a row at a time rather than
 * as one text column: a marker held against a character offset would slide the
 * instant anything above it was edited.
 */
export default function NotesPage({
  store,
  onOpenClass,
}: {
  store: DataStore;
  onOpenClass: (id: string) => void;
}) {
  const { classes, tasks, userId, refresh } = store;
  const [lines, setLines] = useState<ScratchLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The line to put the cursor in once it has rendered. */
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);

  const classById = useMemo(
    () => new Map<string, Class>(classes.map((c) => [c.id, c])),
    [classes],
  );
  const taskById = useMemo(
    () => new Map<string, Task>(tasks.map((t) => [t.id, t])),
    [tasks],
  );

  /*
   * Saving.
   *
   * Text is debounced through the same autosave the note editor uses — the one
   * with a ceiling and a flush on hide, because a page with no Save button has
   * to make "your work is safe" true rather than likely. Everything that is
   * not text (a class marker, a promotion, a delete) is written immediately:
   * those are single deliberate acts, not typing, and there is nothing to
   * batch.
   *
   * The pending edits accumulate in a ref rather than in the payload, so a
   * keystroke on line four does not drop the unsaved half of line two.
   */
  const dirty = useRef(new Map<string, string>());
  const { queue, state } = useAutosave<Record<string, string>>(
    useCallback(async (payload) => {
      const entries = Object.entries(payload);
      for (const [id, text] of entries) {
        // Only clear what was actually written, and only if it has not been
        // typed into again while this was away.
        await db.updateScratchLine(id, { text });
        if (dirty.current.get(id) === text) dirty.current.delete(id);
      }
    }, []),
    { delay: 900, maxDelay: 6000 },
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await db.listScratchLines();
        if (!live) return;
        // An empty pad still needs one line, or there is nothing to click into
        // and the page reads as broken rather than as blank.
        if (rows.length === 0) {
          const first = await db.createScratchLine({ user_id: userId, position: 1 });
          if (!live) return;
          setLines([first]);
        } else {
          setLines(rows);
        }
      } catch (e) {
        if (live) setError(errorText(e, "Could not open your notes"));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  function edit(id: string, text: string) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text } : l)));
    dirty.current.set(id, text);
    queue(Object.fromEntries(dirty.current));
  }

  /**
   * A new line under this one, carrying whatever was to the right of the caret.
   *
   * Splitting rather than always appending, because pressing Enter in the
   * middle of a sentence is how anybody breaks a paragraph in two, and a
   * version that dropped the tail would eat the half you were looking at.
   *
   * The position is the midpoint between its neighbours — the standard trick,
   * and it is why position is a double. Renumbering the whole pad on every
   * Enter would be dozens of writes for one keystroke.
   */
  async function split(line: ScratchLine, at: number) {
    const index = lines.findIndex((l) => l.id === line.id);
    const head = line.text.slice(0, at);
    const tail = line.text.slice(at);
    const after = lines[index + 1];
    const position = after ? (line.position + after.position) / 2 : line.position + 1;

    // The half that stays goes through the ordinary text path, so it is queued
    // like any other edit rather than racing the insert below it.
    if (head !== line.text) edit(line.id, head);

    try {
      const made = await db.createScratchLine({
        user_id: userId,
        text: tail,
        position,
        // A new line inherits the class of the one it was split off. Two
        // thoughts typed one after the other are almost always about the same
        // course, and clearing it would mean re-marking every line by hand.
        class_id: line.class_id,
      });
      setLines((prev) => {
        const next = [...prev];
        next.splice(index + 1, 0, made);
        return next;
      });
      setFocus({ id: made.id, at: 0 });
    } catch (e) {
      toast(errorText(e, "Could not add a line"), "error");
    }
  }

  /**
   * Backspace at the very start of a line joins it to the one above.
   *
   * The behaviour every text editor has, and the reason it is here rather than
   * left out: without it, a line once created can only be removed by finding a
   * small × with the mouse, and a pad you cannot un-type in is not a pad.
   *
   * The first line is never joined into nothing, and a pad never ends up with
   * zero lines — there would be nothing left to click into.
   */
  async function join(line: ScratchLine) {
    const index = lines.findIndex((l) => l.id === line.id);
    if (index <= 0) return;
    const above = lines[index - 1];
    const at = above.text.length;

    setLines((prev) =>
      prev
        .filter((l) => l.id !== line.id)
        .map((l) => (l.id === above.id ? { ...l, text: above.text + line.text } : l)),
    );
    setFocus({ id: above.id, at });
    dirty.current.delete(line.id);

    try {
      await db.deleteScratchLine(line.id);
      edit(above.id, above.text + line.text);
    } catch (e) {
      toast(errorText(e, "Could not join those lines"), "error");
    }
  }

  async function remove(line: ScratchLine) {
    if (lines.length === 1) {
      // The last line is emptied rather than deleted. A pad with no rows in it
      // has nowhere to put the cursor.
      edit(line.id, "");
      return;
    }
    const previous = lines;
    setLines((prev) => prev.filter((l) => l.id !== line.id));
    dirty.current.delete(line.id);
    try {
      await db.deleteScratchLine(line.id);
    } catch (e) {
      setLines(previous);
      toast(errorText(e, "Could not delete that line"), "error");
    }
  }

  async function mark(line: ScratchLine, classId: string) {
    const class_id = classId || null;
    const previous = lines;
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, class_id } : l)));
    try {
      await db.updateScratchLine(line.id, { class_id });
    } catch (e) {
      setLines(previous);
      toast(errorText(e, "Could not tag that line"), "error");
    }
  }

  /**
   * This line turns out to be a task after all.
   *
   * The line stays where it is and gains a marker pointing at the task, rather
   * than being consumed by it. That is deliberate: the pad is where the
   * thought was written down, and a line that vanished on being promoted would
   * leave a hole in the middle of a paragraph that made sense as a paragraph.
   * The marker is also how the line knows, tomorrow, that it has already been
   * dealt with.
   *
   * It inherits the class marker and nothing else. No due date is invented and
   * no estimate is guessed — the whole reason this was a note and not a task
   * is that nobody knew either one.
   */
  async function promote(line: ScratchLine) {
    const title = line.text.trim();
    if (!title) {
      toast("Nothing on that line to make a task of", "info");
      return;
    }
    try {
      const task = await db.createTask({
        user_id: userId,
        title,
        class_id: line.class_id,
      });
      await db.updateScratchLine(line.id, { task_id: task.id });
      setLines((prev) =>
        prev.map((l) => (l.id === line.id ? { ...l, task_id: task.id } : l)),
      );
      // The board is in the shared store, and it is now one task out of date.
      await refresh();
      toast(`"${title}" is on the board`, "success");
    } catch (e) {
      toast(errorText(e, "Could not make that a task"), "error");
    }
  }

  /** Take the marker off. The task itself stays on the board. */
  async function unlink(line: ScratchLine) {
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, task_id: null } : l)));
    try {
      await db.updateScratchLine(line.id, { task_id: null });
    } catch (e) {
      toast(errorText(e, "Could not unlink that"), "error");
    }
  }

  /** A line at the foot, for clicking into the empty space below the last one. */
  async function append() {
    const last = lines[lines.length - 1];
    if (last && !last.text.trim()) {
      setFocus({ id: last.id, at: 0 });
      return;
    }
    try {
      const made = await db.createScratchLine({
        user_id: userId,
        position: (last?.position ?? 0) + 1,
      });
      setLines((prev) => [...prev, made]);
      setFocus({ id: made.id, at: 0 });
    } catch (e) {
      toast(errorText(e, "Could not add a line"), "error");
    }
  }

  const used = lines.filter((l) => l.text.trim()).length;

  return (
    <div className="stack">
      <div className="page-head split">
        <div>
          <h1>Notes</h1>
          <p className="muted small">
            {used
              ? `${used} line${used === 1 ? "" : "s"} you did not want to turn into tasks`
              : "Anything too small to be a task. It saves as you type."}
          </p>
        </div>
        {/* Only ever says something while there is something to say. A
            permanent "Saved" badge is a claim the page has to keep making. */}
        {state === "saving" || state === "dirty" ? (
          <span className="muted small">Saving…</span>
        ) : state === "error" ? (
          <span className="error small">Not saved — check your connection</span>
        ) : null}
      </div>

      {loading ? (
        <p className="muted">Opening your notes…</p>
      ) : error ? (
        <section className="panel">
          <p className="error">{error}</p>
        </section>
      ) : (
        <section className="panel pad">
          {lines.map((line) => (
            <PadLine
              key={line.id}
              line={line}
              cls={line.class_id ? classById.get(line.class_id) ?? null : null}
              task={line.task_id ? taskById.get(line.task_id) ?? null : null}
              classes={classes.filter((c) => !c.hidden)}
              focus={focus?.id === line.id ? focus.at : null}
              onFocused={() => setFocus(null)}
              onEdit={(text) => edit(line.id, text)}
              onSplit={(at) => void split(line, at)}
              onJoin={() => void join(line)}
              onRemove={() => void remove(line)}
              onMark={(id) => void mark(line, id)}
              onPromote={() => void promote(line)}
              onUnlink={() => void unlink(line)}
              onOpenClass={onOpenClass}
            />
          ))}

          {/* The rest of the page is clickable, because on a page made of
              lines the empty part below the last one is where a hand goes. */}
          <button className="pad-rest" onClick={() => void append()} aria-label="Add a line" />
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One line: the text, and the two markers it may carry.
 *
 * A textarea rather than an input, so a long thought wraps and stays readable
 * instead of scrolling sideways inside a single row. It grows to its own
 * content, which is what makes a stack of these read as one page rather than
 * as a form with thirty fields in it.
 */
function PadLine({
  line,
  cls,
  task,
  classes,
  focus,
  onFocused,
  onEdit,
  onSplit,
  onJoin,
  onRemove,
  onMark,
  onPromote,
  onUnlink,
  onOpenClass,
}: {
  line: ScratchLine;
  cls: Class | null;
  /** The task this line became, if it is still on the board. */
  task: Task | null;
  classes: Class[];
  /** Where to put the caret when this line has just been created or joined. */
  focus: number | null;
  onFocused: () => void;
  onEdit: (text: string) => void;
  onSplit: (at: number) => void;
  onJoin: () => void;
  onRemove: () => void;
  onMark: (classId: string) => void;
  onPromote: () => void;
  onUnlink: () => void;
  onOpenClass: (id: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement | null>(null);

  // Height follows content, every render and on every keystroke. Reset to auto
  // first or the box can only ever grow — scrollHeight of an already-tall
  // element is its own height.
  const grow = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(grow, [grow, line.text]);

  useEffect(() => {
    if (focus === null) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    const at = Math.min(focus, el.value.length);
    el.setSelectionRange(at, at);
    onFocused();
  }, [focus, onFocused]);

  return (
    <div className={`pad-line${cls ? ` hue-${cls.color}` : ""}`}>
      <textarea
        ref={box}
        rows={1}
        className="pad-text"
        value={line.text}
        placeholder="…"
        onChange={(e) => {
          onEdit(e.target.value);
          grow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSplit(e.currentTarget.selectionStart);
            return;
          }
          if (
            e.key === "Backspace" &&
            e.currentTarget.selectionStart === 0 &&
            e.currentTarget.selectionEnd === 0
          ) {
            e.preventDefault();
            onJoin();
          }
        }}
      />

      {/* Markers first, then the actions that set them. What a line already
          says outranks what could be done to it. */}
      <div className="pad-marks">
        {cls && (
          <button
            className="tag tag-hue tag-button"
            onClick={() => onOpenClass(cls.id)}
            title={`Open ${cls.name}`}
          >
            <span className="dot" />
            {cls.name}
          </button>
        )}

        {line.task_id &&
          (task ? (
            <button
              className={`tag pad-task${task.status === "done" ? " struck" : ""}`}
              onClick={onUnlink}
              title="On the board. Click to take the marker off — the task stays."
            >
              {task.status === "done" ? "Task · done" : "Task"}
            </button>
          ) : (
            // The task was deleted from the board. Said plainly rather than
            // silently dropped: the line is still a line, and the marker
            // going quiet would look like the promotion never happened.
            <button className="tag muted" onClick={onUnlink} title="That task is gone">
              Task · deleted
            </button>
          ))}
      </div>

      <div className="pad-actions">
        <ClassPicker classes={classes} value={line.class_id ?? ""} onChange={onMark} />
        {!line.task_id && (
          <button className="link" onClick={onPromote} title="Put this on the board">
            Make task
          </button>
        )}
        <button className="link danger" onClick={onRemove} title="Delete this line">
          ×
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import * as db from "../lib/db";
import * as notesApi from "../lib/notes";
import { getClassroomCourses, type ClassroomCourse } from "../lib/api";
import { CLASS_COLORS } from "../lib/types";
import type { HealthTask } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import { toast } from "../lib/toast";
import ClassCard from "../components/ClassCard";
import ClassroomPanel from "../components/ClassroomPanel";

/**
 * Home: every class you are taking, as a grid of cards.
 *
 * Nothing else. The add-a-task form that used to sit above this moved to the
 * To do tab, where the board it feeds lives — typing a deadline is an action
 * about your work, not about your timetable, and the two screens are now
 * split along exactly that line.
 */
export default function ClassesPage({
  store,
  session,
  classroomEnabled,
  onOpen,
}: {
  store: DataStore;
  session: Session;
  classroomEnabled: boolean;
  onOpen: (id: string) => void;
}) {
  const { classes, tasks, refresh, userId } = store;
  const visible = classes.filter((c) => !c.hidden);
  const [adding, setAdding] = useState(false);
  const [noteCounts, setNoteCounts] = useState<Record<string, number> | null>(null);
  const [archive, setArchive] = useState<HealthTask[] | null>(null);

  // Counts are decoration on a card that is already useful without them, so
  // they load separately and their failure is silent — a grid that refuses to
  // render because a note tally did not arrive would be a worse trade.
  useEffect(() => {
    let live = true;
    notesApi
      .countNotesByClass()
      .then((c) => live && setNoteCounts(c))
      .catch(() => live && setNoteCounts({}));
    return () => {
      live = false;
    };
  }, [classes.length]);

  // The archive, for the health bars. Same contract as the note counts: a
  // card is useful without it, so it loads on its own and a failure leaves
  // the bars reading only live rows rather than blocking the grid.
  useEffect(() => {
    let live = true;
    db.listArchivedTasks()
      .then((a) => live && setArchive(a))
      .catch(() => live && setArchive([]));
    return () => {
      live = false;
    };
  }, [tasks.length]);

  const historyByClass = useMemo(() => {
    const m = new Map<string, HealthTask[]>();
    for (const t of archive ?? []) {
      if (!t.class_id) continue;
      const list = m.get(t.class_id);
      if (list) list.push(t);
      else m.set(t.class_id, [t]);
    }
    return m;
  }, [archive]);

  const byClass = useMemo(() => {
    const m = new Map<string, typeof tasks>();
    for (const t of tasks) {
      if (!t.class_id) continue;
      const list = m.get(t.class_id);
      if (list) list.push(t);
      else m.set(t.class_id, [t]);
    }
    return m;
  }, [tasks]);

  const unassigned = tasks.filter((t) => !t.class_id && t.status !== "done").length;

  return (
    <div className="stack">
      <div className="row page-head">
        <div className="grow">
          <h1>Your classes</h1>
          <p className="muted small">
            {visible.length
              ? `${visible.length} class${visible.length === 1 ? "" : "es"} this term`
              : "Add the classes you are taking, or import them from Classroom."}
          </p>
        </div>
        <button
          className={adding ? "btn-quiet" : ""}
          onClick={() => setAdding((a) => !a)}
        >
          {adding ? "Cancel" : "Add class"}
        </button>
      </div>

      {adding && (
        <AddClassForm
          userId={userId}
          classroomEnabled={classroomEnabled}
          onDone={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}

      {visible.length === 0 && !adding ? (
        <div className="panel empty-state">
          <p className="empty-title">No classes yet</p>
          <p className="muted">
            Add one, or connect Classroom below to import your courses.
          </p>
        </div>
      ) : (
        <div className="class-grid">
          {visible.map((c) => (
            <ClassCard
              key={c.id}
              cls={c}
              tasks={byClass.get(c.id) ?? []}
              history={archive ? (historyByClass.get(c.id) ?? []) : null}
              noteCount={noteCounts ? (noteCounts[c.id] ?? 0) : null}
              onOpen={() => onOpen(c.id)}
            />
          ))}
        </div>
      )}

      {/* Tasks with no class are real — laundry, a club meeting, a doctor's
          appointment — and this grid is organised by something they do not
          have. Rather than invent a Miscellaneous class to hold them, say
          they exist and point at the board that shows them. */}
      {unassigned > 0 && (
        <p className="muted small">
          {unassigned} task{unassigned === 1 ? "" : "s"} without a class —
          they&rsquo;re on the To do board.
        </p>
      )}

      {classroomEnabled && (
        <ClassroomPanel session={session} onSynced={refresh} />
      )}
    </div>
  );
}

/**
 * Adding a class. Colour is picked, not typed: it is the thing the grid is
 * scanned by, and a free-form value could drift to something unstyled.
 */
function AddClassForm({
  userId,
  classroomEnabled,
  onDone,
}: {
  userId: string;
  classroomEnabled: boolean;
  onDone: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [professor, setProfessor] = useState("");
  const [color, setColor] = useState<string>(CLASS_COLORS[0]);
  const [courseId, setCourseId] = useState("");
  const [courses, setCourses] = useState<ClassroomCourse[] | null>(null);
  const [coursesError, setCoursesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The picker's options, fetched when the form opens rather than on app
   * load: this is the only screen that needs them and it costs a live call
   * to Google. A failure is reported inline and nothing else on the form
   * stops working — linking is optional, and a class you can create without
   * a link is better than a form that refuses to open because Render is cold.
   */
  useEffect(() => {
    if (!classroomEnabled) return;
    let live = true;
    getClassroomCourses()
      .then((c) => live && setCourses(c))
      .catch((e: unknown) => {
        if (!live) return;
        setCourses([]);
        setCoursesError(
          e instanceof Error ? e.message : "Could not reach Classroom",
        );
      });
    return () => {
      live = false;
    };
  }, [classroomEnabled]);

  const available = (courses ?? []).filter((c) => !c.linked_class_id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await db.createClass({
        user_id: userId,
        name: name.trim(),
        color,
        professor: professor.trim() || null,
        google_course_id: courseId || null,
      });
      toast(
        courseId
          ? `Added ${name.trim()} — its Classroom work arrives on the next sync`
          : `Added ${name.trim()}`,
        "success",
      );
      setName("");
      setProfessor("");
      setCourseId("");
      await onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add class", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>New class</h2>
      <form className="add-class-form" onSubmit={submit}>
        <label>
          <span className="label">Name</span>
          <input
            autoFocus
            placeholder="e.g. CS-2212"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          <span className="label">Professor (optional)</span>
          <input
            placeholder="e.g. Dr. Rao"
            value={professor}
            onChange={(e) => setProfessor(e.target.value)}
          />
        </label>

        {classroomEnabled && (
          <label className="field-wide">
            <span className="label">Google Classroom course (optional)</span>
            <select
                value={courseId}
                disabled={courses === null || available.length === 0}
                onChange={(e) => {
                  setCourseId(e.target.value);
                  // Prefill the name from the course, but only while the
                  // field is untouched — overwriting a name someone typed
                  // would be the picker deciding it knows better.
                  const picked = available.find((c) => c.id === e.target.value);
                  if (picked && !name.trim()) setName(picked.name);
                }}
              >
                <option value="">
                  {courses === null
                    ? "Loading your courses…"
                    : available.length === 0
                      ? "No unlinked courses"
                      : "Don’t link"}
                </option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.section ? ` · ${c.section}` : ""}
                  </option>
                ))}
            </select>
            <span className="field-hint muted small">
              {coursesError
                ? `Couldn’t load courses: ${coursesError}. You can still create the class and link it later by matching names.`
                : "Linked classes pull in their coursework automatically."}
            </span>
          </label>
        )}

        <fieldset className="swatches">
          <legend className="label">Colour</legend>
          {CLASS_COLORS.map((c) => (
            <label key={c} className={`swatch hue-${c}`} title={c}>
              <input
                type="radio"
                name="color"
                value={c}
                checked={color === c}
                onChange={() => setColor(c)}
              />
              <span className="swatch-dot" aria-hidden="true" />
              <span className="sr-only">{c}</span>
            </label>
          ))}
        </fieldset>

        <div className="add-class-submit">
          <button disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add class"}
          </button>
        </div>
      </form>
    </section>
  );
}

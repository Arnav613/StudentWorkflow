import { useCallback, useEffect, useMemo, useState } from "react";
import * as db from "../lib/db";
import { toast } from "../lib/toast";
import { clockOf } from "../lib/schedule";
import { classForEvent } from "../lib/weekgrid";
import type { CalendarSeries, Class, ClassEventLink } from "../lib/types";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "This calendar entry is this class."
 *
 * The link already existed and there was nowhere to make it. It lived in the
 * popover of a lecture on the Week grid, which is the right place to *confirm*
 * one — the block is in front of you — and the wrong place to go looking for
 * one, because you have to already know that a calendar block has a panel and
 * that the panel has a picker in it. Nobody setting a course up on the Classes
 * tab is going to find that.
 *
 * So the question is asked from the other end as well: here is the course, and
 * here is everything Google thinks is on your calendar. The two views write the
 * same row and the answer is the same answer, whichever end you approach it
 * from.
 *
 * It is asked per *series*: Google expands a weekly lecture into one row a
 * week, and answering per occurrence would ask the same question every Monday
 * for a term.
 */
export default function LecturesPanel({
  cls,
  classes,
  userId,
  /** Called when a link changes, so the timetable beside it can catch up. */
  onChange,
}: {
  cls: Class;
  classes: Class[];
  userId: string;
  onChange?: () => void;
}) {
  const [series, setSeries] = useState<CalendarSeries[]>([]);
  const [links, setLinks] = useState<ClassEventLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** The series being written, so its own row can say so and not the others. */
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, ls] = await Promise.all([
        // From the start of today. Yesterday's lecture is still the same
        // series, but a list of things that have already happened is a worse
        // way to recognise a course than a list of things about to.
        db.listCalendarSeries(new Date(new Date().setHours(0, 0, 0, 0))),
        db.listClassEventLinks(),
      ]);
      setSeries(rows);
      setLinks(ls);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast(message(e), "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const linkedTo = useMemo(
    () => new Map(links.map((l) => [l.google_series_id, l.class_id])),
    [links],
  );
  const classById = useMemo(
    () => new Map(classes.map((c) => [c.id, c])),
    [classes],
  );

  /**
   * This class's lectures first, then the plausible ones, then the rest.
   *
   * A term's calendar is thirty series long and five of them could conceivably
   * be this course. Listing them in Google's alphabetical order would bury the
   * answer among other people's gym sessions; the title match that already
   * tints the Week grid is a good enough guess to sort by, and sorting is the
   * one use of a guess that cannot be wrong about anything.
   */
  const sorted = useMemo(() => {
    const rank = (s: CalendarSeries) => {
      if (linkedTo.get(s.google_series_id) === cls.id) return 0;
      if (linkedTo.has(s.google_series_id)) return 3;
      return classForEvent(s.title, [cls]) ? 1 : 2;
    };
    return [...series].sort(
      (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title),
    );
  }, [series, linkedTo, cls]);

  /*
   * Five, then the rest behind a button.
   *
   * The first few are the ones the sort believes in, and a class page that
   * opens with thirty calendar entries in it is a class page about somebody's
   * calendar. Anything already linked here is always among them, whatever the
   * count — hiding the answer you gave would make the panel look unanswered.
   */
  const mine = sorted.filter((s) => linkedTo.get(s.google_series_id) === cls.id);
  const visible = showAll ? sorted : sorted.slice(0, Math.max(5, mine.length));

  async function toggle(s: CalendarSeries) {
    const already = linkedTo.get(s.google_series_id) === cls.id;
    setBusy(s.google_series_id);
    try {
      if (already) {
        await db.unlinkEventSeries(s.google_series_id);
        setLinks((prev) =>
          prev.filter((l) => l.google_series_id !== s.google_series_id),
        );
      } else {
        const saved = await db.linkEventSeries({
          user_id: userId,
          google_series_id: s.google_series_id,
          class_id: cls.id,
        });
        // Upserted on the series, so this replaces whatever it said before —
        // including a link to a different class. One lecture, one answer.
        setLinks((prev) => [
          ...prev.filter((l) => l.google_series_id !== s.google_series_id),
          saved,
        ]);
      }
      onChange?.();
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Lectures</h2>
        <span className="muted small">
          {mine.length
            ? `${mine.length} calendar ${mine.length === 1 ? "entry is" : "entries are"} ${cls.name}`
            : "Which of your calendar entries is this class?"}
        </span>
      </div>

      {/* Said plainly, because this is the sentence that explains why the
          timetable below is worth uploading at all. */}
      <p className="muted small">
        Linked lectures show this class&rsquo;s colour on the Week grid, and
        carry the day&rsquo;s topic from the timetable below.
      </p>

      {loading ? (
        <p className="muted small">Reading your calendar…</p>
      ) : failed ? (
        <p className="muted small">
          Could not read your calendar entries. Open the Week tab once — it is
          what mirrors Google — and come back.
        </p>
      ) : !series.length ? (
        /* No mirror yet. Not an error and not this panel's to fix: the Week
           tab is what syncs, and the Classes tab owns the reconnect prompt. */
        <p className="muted small">
          Nothing on your calendar for the next few days. Connect Google
          Calendar and open the Week tab, and your lectures will appear here.
        </p>
      ) : (
        <>
          <ul className="list lecture-links">
            {visible.map((s) => {
              const owner = linkedTo.get(s.google_series_id);
              const ours = owner === cls.id;
              const other = owner && !ours ? classById.get(owner) : null;
              const when = new Date(s.starts_at);
              return (
                <li
                  key={s.google_series_id}
                  className={`lecture-link${ours ? " linked" : ""}`}
                >
                  <span className="grow">
                    <span className="ellipsis">{s.title}</span>
                    <span className="muted small">
                      {WEEKDAYS[when.getDay()]} {clockOf(when)}
                      {s.occurrences > 1 ? ` · ${s.occurrences} ahead` : ""}
                      {/* Whose it is, if not ours. Said rather than hidden:
                          linking it here moves it, and moving something is a
                          thing you should be able to see coming. */}
                      {other ? ` · currently ${other.name}` : ""}
                    </span>
                  </span>
                  <button
                    className={ours ? "btn-quiet" : ""}
                    disabled={busy === s.google_series_id}
                    onClick={() => void toggle(s)}
                  >
                    {busy === s.google_series_id
                      ? "…"
                      : ours
                        ? "Unlink"
                        : other
                          ? "Move here"
                          : "This is it"}
                  </button>
                </li>
              );
            })}
          </ul>

          {sorted.length > visible.length && (
            <button className="link" onClick={() => setShowAll(true)}>
              Show {sorted.length - visible.length} more
            </button>
          )}
        </>
      )}
    </section>
  );
}

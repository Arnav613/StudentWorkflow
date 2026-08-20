import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "../lib/db";
import type { ClassLink } from "../lib/types";
import { toast, undoable } from "../lib/toast";
import { summariseLink } from "../lib/api";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

/**
 * The hostname: the name of a link that was never given one, and — under a
 * link that was — the honest version of where the click actually goes, since
 * the title is only whatever the user typed.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Docs: the links that belong to a class.
 *
 * A syllabus, a Drive folder, a reading list, the course page. Links rather
 * than uploads — the things a student needs to reach from a class already
 * live somewhere with a URL, and keeping second copies here would add a
 * storage bucket and a way for the copy to go stale, in exchange for nothing
 * the link did not already do.
 */
export default function DocsPanel({
  classId,
  userId,
  aiEnabled,
}: {
  classId: string;
  userId: string;
  aiEnabled: boolean;
}) {
  const [links, setLinks] = useState<ClassLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Summarising, per row.
   *
   * `reasons` holds the answers that are not summaries — a PDF, a plain link,
   * a permission not granted. They are kept in memory and not in the database
   * because none of them is a fact about the document: grant the permission
   * and the same row answers differently.
   *
   * Phase 10 taught the app to read a PDF, but only one it was handed — an
   * upload, on the Timetable or Grades tab. This tab is still links, and the
   * rule that this server does not fetch a URL somebody typed has not moved.
   */
  const [summarising, setSummarising] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function summarise(link: ClassLink) {
    setSummarising(link.id);
    setReasons((r) => ({ ...r, [link.id]: "" }));
    try {
      const out = await summariseLink(link.id);
      if (out.summary) {
        setLinks((prev) =>
          db.withSummary(prev, link.id, out.summary as string, out.generated_at),
        );
      } else if (out.reason) {
        // Not a toast and not red. "Can’t read this file type" is an answer,
        // and the row it belongs to is the place to say it.
        setReasons((r) => ({ ...r, [link.id]: out.reason as string }));
      }
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setSummarising(null);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLinks(await db.listClassLinks(classId));
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const saved = await db.createClassLink({
        user_id: userId,
        class_id: classId,
        title: title.trim(),
        url: url.trim(),
        // Appended, not prepended: the list is hand-ordered and the syllabus
        // someone pinned first should stay first.
        position: links.reduce((max, l) => Math.max(max, l.position), 0) + 1,
      });
      setLinks((prev) => [...prev, saved]);
      setTitle("");
      setUrl("");
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hand-ordering.
   *
   * Native HTML5 drag rather than dnd-kit, which the board uses: this is a
   * short vertical list with a grip, and pulling in @dnd-kit/sortable — not
   * currently a dependency — to move three rows would cost more than it
   * buys. The board's needs are genuinely different: it drags between
   * containers, with a travelling overlay.
   *
   * Native drag is mouse-only, so the same reorder is offered as Move up /
   * Move down buttons. That is not a nicety — without them this feature does
   * not exist for anyone using a keyboard.
   */
  const dragFrom = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  function move(from: number, to: number) {
    if (to < 0 || to >= links.length || from === to) return;

    const next = [...links];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    const previous = links;
    // Renumbered densely from zero. Positions are a sort key, not an
    // identity, and rewriting the whole short list is one request that cannot
    // leave two rows claiming the same slot.
    const renumbered = next.map((l, i) => ({ ...l, position: i }));
    setLinks(renumbered);

    void (async () => {
      try {
        await Promise.all(
          renumbered
            .filter((l, i) => previous[i]?.id !== l.id)
            .map((l) => db.updateClassLink(l.id, { position: l.position })),
        );
      } catch (e) {
        setLinks(previous);
        toast(message(e), "error");
      }
    })();
  }

  function remove(link: ClassLink) {
    const previous = links;
    undoable({
      message: `Removed ${link.title || hostOf(link.url)}`,
      apply: () => setLinks((prev) => prev.filter((l) => l.id !== link.id)),
      commit: () => db.deleteClassLink(link.id),
      revert: () => setLinks(previous),
    });
  }

  return (
    <div className="stack">
      <section className="panel">
        <h2>Add a link</h2>
        <form className="docs-form" onSubmit={add}>
          <label className="grow">
            <span className="label">Link</span>
            <input
              // Not type="url": that would reject `drive.google.com/…` typed
              // without a scheme, which is how people actually paste. The
              // scheme is added on save instead — see db.normaliseUrl.
              placeholder="drive.google.com/… or a course page"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
          <label>
            <span className="label">Name (optional)</span>
            <input
              placeholder="Syllabus"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div>
            <button disabled={busy || !url.trim()}>
              {busy ? "Saving…" : "Add"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Links</h2>
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : links.length === 0 ? (
          <div className="empty-state">
            <p className="empty-title">Nothing pinned yet</p>
          </div>
        ) : (
          <ul className="list docs-list">
            {links.map((l, i) => (
              <li
                key={l.id}
                className={overIndex === i ? "doc-over" : ""}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverIndex(i);
                }}
                onDragLeave={() => setOverIndex((o) => (o === i ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current !== null) move(dragFrom.current, i);
                  dragFrom.current = null;
                  setOverIndex(null);
                }}
              >
                {/* Only the grip starts a drag. The row holds a link, and a
                    draggable anchor is one that cannot be reliably clicked. */}
                <span
                  className="doc-grip"
                  draggable
                  onDragStart={(e) => {
                    dragFrom.current = i;
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox starts no drag at all without payload.
                    e.dataTransfer.setData("text/plain", l.id);
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setOverIndex(null);
                  }}
                  aria-hidden="true"
                  title="Drag to reorder"
                >
                  ⠿
                </span>
                <span className="doc-icon" aria-hidden="true">
                  ↗
                </span>
                <a
                  className="grow doc-link"
                  href={l.url}
                  target="_blank"
                  // noreferrer as well as noopener: the target should not be
                  // told which dashboard sent the click.
                  rel="noreferrer"
                >
                  <span className="doc-title">
                    {l.title || hostOf(l.url)}
                    {/* Where this row came from. A link a professor attached
                        and a link you pasted sit in one list on purpose — a
                        syllabus is a syllabus — but which is which is worth
                        knowing before you rename one. */}
                    {l.google_material_id && (
                      <span
                        className="tag"
                        title="Attached to a Classroom post"
                      >
                        Classroom
                      </span>
                    )}
                  </span>
                  {/* The host is shown under a name the user chose, as the
                      honest version of where the click goes. When there is no
                      name the host is already the title, and printing it
                      twice just looks broken. */}
                  {l.title.trim() && (
                    <span className="doc-host muted small">{hostOf(l.url)}</span>
                  )}
                </a>
                <span className="doc-actions">
                  <button
                    className="link icon-btn"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0}
                    aria-label={`Move ${l.title || hostOf(l.url)} up`}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className="link icon-btn"
                    onClick={() => move(i, i + 1)}
                    disabled={i === links.length - 1}
                    aria-label={`Move ${l.title || hostOf(l.url)} down`}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className="link danger icon-btn"
                    onClick={() => remove(l)}
                    aria-label={`Remove ${l.title || hostOf(l.url)}`}
                    title="Remove"
                  >
                    ×
                  </button>
                </span>

                {/* Offered only where it can work: a Drive file this app was
                    told about by Classroom. A pasted link is never fetched —
                    that was phase 06's rule and it still holds — and a
                    deployment without a model shows no button rather than one
                    that fails. */}
                {aiEnabled && l.google_drive_id && !l.summary && (
                  <button
                    className="link doc-summarise"
                    onClick={() => void summarise(l)}
                    disabled={summarising === l.id}
                  >
                    {summarising === l.id ? "Reading…" : "Summarise"}
                  </button>
                )}

                {l.summary && (
                  <p className="doc-summary small muted">
                    {l.summary}
                    {/* Said out loud on every summary, every time. This is the
                        one thing on the Docs tab a machine wrote, and a
                        paragraph that does not say so reads as the document
                        itself. */}
                    <span className="doc-summary-mark"> · AI summary</span>
                  </p>
                )}

                {reasons[l.id] && (
                  <p className="doc-summary small muted">{reasons[l.id]}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

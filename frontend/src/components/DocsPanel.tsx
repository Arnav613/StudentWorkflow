import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "../lib/db";
import type { ClassLink } from "../lib/types";
import { toast, undoable } from "../lib/toast";

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
}: {
  classId: string;
  userId: string;
}) {
  const [links, setLinks] = useState<ClassLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

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
            <p className="muted">
              Put the syllabus, the shared Drive folder and the course page
              here, so they are one click from the work instead of eleven tabs
              deep.
            </p>
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
                  <span className="doc-title">{l.title || hostOf(l.url)}</span>
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

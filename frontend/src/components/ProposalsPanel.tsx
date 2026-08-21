import { useCallback, useEffect, useState } from "react";
import * as db from "../lib/db";
import { deadlinePayload, type Proposal } from "../lib/types";
import type { DataStore } from "../hooks/useData";
import { toast } from "../lib/toast";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

/** A due date as a person reads it, from the YYYY-MM-DD a model returned. */
function readableDate(iso: string): string {
  const d = new Date(`${iso}T00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * The review queue: deadlines a model thinks it found, waiting to be agreed with.
 *
 * A panel, not a tab, because it is empty almost always. A professor moves a
 * date maybe twice a term, so a permanent tab would be a permanent invitation
 * to visit an empty room — and worse, it would make the two or three moments
 * this matters look like routine housekeeping rather than news.
 *
 * It sits at the top of To do rather than inside a class, because a moved
 * deadline is exactly the thing you need to see when you are deciding what to
 * do next, and you do not go looking for it one course at a time.
 *
 * Each proposal renders beside the professor's own sentence. That is the part
 * that makes approval mean anything: a date with no source can only be
 * accepted on faith, and a queue people accept on faith is a queue that writes
 * whatever a model says, one press later.
 */
export default function ProposalsPanel({ store }: { store: DataStore }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProposals(await db.listPendingProposals());
    } catch {
      // Silent, and the one place in this app where that is right. This is a
      // panel that is empty on almost every load; a red error above the board
      // because a rare, optional queue could not be read would be a louder
      // failure than the feature is worth.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Malformed payloads are dropped rather than rendered. These rows are the
  // only ones in the database written from model output, so this is where the
  // shape is checked instead of trusted.
  const items = proposals
    .map((p) => ({ p, payload: deadlinePayload(p) }))
    .filter((x): x is { p: Proposal; payload: NonNullable<typeof x.payload> } =>
      Boolean(x.payload),
    );

  if (items.length === 0) return null;

  function forget(id: string) {
    setProposals((prev) => prev.filter((p) => p.id !== id));
  }

  async function accept(item: (typeof items)[number]) {
    setBusy(item.p.id);
    try {
      await db.acceptProposal(item.p, item.payload, store.userId);
      forget(item.p.id);
      // The task is the confirmation, so refresh the board that will show it.
      await store.refresh();
      toast(`Added ${item.payload.title}`, "info");
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function reject(item: (typeof items)[number]) {
    setBusy(item.p.id);
    try {
      await db.rejectProposal(item.p.id);
      forget(item.p.id);
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel proposals">
      <h2>
        Found in an announcement
        <span className="tag" title="Suggested by AI, and not saved until you agree">
          Needs your OK
        </span>
      </h2>
      <p className="muted small">
{items.length === 1
          ? "One possible deadline, from a professor’s post."
          : `${items.length} possible deadlines, from professors’ posts.`}
      </p>

      <ul className="list proposal-list">
        {items.map(({ p, payload }) => {
          const cls = store.classes.find((c) => c.id === p.class_id);
          return (
            <li key={p.id} className={cls ? `hue-${cls.color}` : undefined}>
              <div className="grow stack-tight">
                <p className="proposal-title">
                  <strong>{payload.title}</strong>
                  <span className="muted"> · {readableDate(payload.due_date)}</span>
                </p>
                <p className="muted small">
                  {cls?.name ?? payload.class_name ?? "No class"}
                </p>
                {/* The professor's words, unedited. Without them the only
                    thing on offer is a date and a request to trust it. */}
                {payload.excerpt && (
                  <blockquote className="proposal-excerpt small">
                    “{payload.excerpt}”
                  </blockquote>
                )}
                {payload.announcement_url && (
                  <a
                    className="small"
                    href={payload.announcement_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the announcement ↗
                  </a>
                )}
              </div>
              <span className="proposal-actions">
                <button onClick={() => accept({ p, payload })} disabled={busy === p.id}>
                  Add as a task
                </button>
                {/* Not "delete". The row is kept as the memory of this answer,
                    which is what stops the hourly sync asking again. */}
                <button
                  className="link"
                  onClick={() => reject({ p, payload })}
                  disabled={busy === p.id}
                >
                  No thanks
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

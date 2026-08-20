import { useState } from "react";
import * as db from "../lib/db";
import { toast, errorText } from "../lib/toast";
import { clockOf, isoDate } from "../lib/schedule";
import TimePicker from "./TimePicker";
import type { Blackout } from "../lib/types";

/**
 * Hours that are gone, and are neither work nor a routine.
 *
 * "Out on Wednesday afternoon" had nowhere to live. As a task it would sit on
 * the board asking to be ticked off; as a routine it would come back every
 * Wednesday for the rest of term. It is its own row, and all it does is take
 * time away from the planner — which is why there is no colour picker here and
 * no way to attach one to a class. A blackout is an absence.
 *
 * The list is short and it is the whole manager, unlike routines: a routine is
 * drawn on the grid seven times and can be edited there, but a blackout is one
 * band on one day, and dragging an absence to a new time is a stranger gesture
 * than deleting it and saying the new one.
 */
export default function BlackoutsPanel({
  blackouts,
  userId,
  onChange,
}: {
  blackouts: Blackout[];
  userId: string;
  /** Reload and replan. A blackout that did not move the week is a note. */
  onChange: () => Promise<void>;
}) {
  const [day, setDay] = useState(isoDate(new Date()));
  const [from, setFrom] = useState("14:00");
  const [to, setTo] = useState("18:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!day || !from || !to) return;
    // Local, deliberately. The pair you typed is an afternoon where you are
    // standing, and `new Date("2026-08-24T14:00")` — no Z, no offset — is the
    // one constructor that reads it that way.
    const starts = new Date(`${day}T${from}`);
    const ends = new Date(`${day}T${to}`);
    if (!(ends > starts)) {
      toast("That block ends before it starts", "error");
      return;
    }
    setBusy(true);
    try {
      await db.createBlackout({
        user_id: userId,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        reason: reason.trim() || null,
      });
      setReason("");
      await onChange();
      toast("Those hours are off the table", "success");
    } catch (err) {
      toast(errorText(err, "Could not block that out"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: Blackout) {
    try {
      await db.deleteBlackout(b.id);
      await onChange();
      toast("Those hours are yours again", "success");
    } catch (err) {
      toast(errorText(err, "Could not remove that"), "error");
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Blocked out</h2>
        <span className="muted small">
          One-off hours the planner may not use. Not a routine, and not
          something to tick off.
        </span>
      </div>

      <form className="routine-form" onSubmit={add}>
        <input
          placeholder="Out, travelling, dentist…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-label="Day"
          required
        />
        <TimePicker value={from} onChange={setFrom} />
        <span className="muted small">to</span>
        <TimePicker value={to} onChange={setTo} />
        <button disabled={busy}>Block out</button>
      </form>

      {blackouts.length > 0 && (
        <ul className="list blackout-list">
          {blackouts.map((b) => (
            <li key={b.id} className="blackout-row">
              <span className="blackout-when">
                {new Date(b.starts_at).toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}{" "}
                {clockOf(b.starts_at)}–{clockOf(b.ends_at)}
              </span>
              <span className="muted small">{b.reason ?? "Blocked"}</span>
              <button
                className="btn-quiet danger"
                onClick={() => void remove(b)}
                aria-label="Remove"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

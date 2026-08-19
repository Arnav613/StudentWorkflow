import type { Session } from "@supabase/supabase-js";
import { signOut } from "../lib/supabase";

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string }
  | { kind: "error"; message: string };

/**
 * Phase 00 placeholder. Phase 02 turns this into the real Do / Doing / Done
 * board; for now it exists to prove the full chain end to end — Google, then
 * Supabase, then our own JWT check on the backend.
 */
export default function Board({
  session,
  backend,
}: {
  session: Session;
  backend: BackendState;
}) {
  return (
    <div className="page">
      <header className="topbar">
        <strong>Student Dashboard</strong>
        <span className="muted">{session.user.email}</span>
        <button onClick={() => signOut()}>Sign out</button>
      </header>

      <main>
        <h1>You are signed in.</h1>

        {backend.kind === "checking" && (
          // Render's free tier sleeps. A cold start is ~30s, and without this
          // line every first open of the day reads as a broken app.
          <p className="muted">
            Waking the server… the first request after a quiet spell can take
            up to a minute.
          </p>
        )}

        {backend.kind === "ok" && (
          <p className="ok">API reached and token verified as {backend.email}.</p>
        )}

        {backend.kind === "error" && (
          <p className="error">API error: {backend.message}</p>
        )}

        <p className="muted">
          Next up: classes and tasks by hand (phase 01), then the board
          (phase 02).
        </p>
      </main>
    </div>
  );
}

import { useState } from "react";
import { supabase } from "../lib/supabase";

/**
 * A probe, not a feature.
 *
 * Finds out empirically whether Ashoka's Workspace actually blocks this OAuth
 * client from the Classroom scopes. Deliberately separate from the main
 * sign-in: if consent is refused, the worst case is this button failing, not
 * everyone losing the ability to log in.
 *
 * There are three distinct outcomes and they mean different things:
 *   - Google refuses at the consent screen  -> admin blocks the scopes. The
 *     plan's assumption holds and phase 04 is the only way through.
 *   - Consent succeeds, API returns 403     -> app allowed, Classroom API not
 *     enabled on the project, or the account has no Classroom access.
 *   - Courses come back                     -> not blocked. Phase 05 is
 *     unblocked today and the plan reorders again.
 *
 * If this turns out to work, this file gets deleted and rebuilt properly as
 * phase 05 — with token storage, refresh, and the conflict rule. Nothing here
 * persists a token anywhere.
 */

const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
].join(" ");

type Result =
  | { kind: "idle" }
  | { kind: "calling" }
  | { kind: "no-token" }
  | { kind: "ok"; courses: { id: string; name: string }[] }
  | { kind: "http-error"; status: number; body: string };

export default function ClassroomProbe() {
  const [result, setResult] = useState<Result>({ kind: "idle" });

  /** Re-runs consent, this time asking for the two Classroom scopes. */
  async function connect() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes: SCOPES,
        redirectTo: window.location.origin,
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
  }

  /**
   * Calls Classroom directly from the browser with the provider token.
   *
   * Supabase surfaces provider_token only on the session immediately after
   * the OAuth redirect — it is not persisted across a page reload. That is
   * fine for a probe and is exactly the problem phase 05 solves properly by
   * storing an encrypted refresh token server-side.
   */
  async function callClassroom() {
    setResult({ kind: "calling" });
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const token = session?.provider_token;
    if (!token) return setResult({ kind: "no-token" });

    const res = await fetch(
      "https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE",
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const body = await res.text();
    if (!res.ok) {
      return setResult({ kind: "http-error", status: res.status, body });
    }
    const parsed = JSON.parse(body);
    setResult({ kind: "ok", courses: parsed.courses ?? [] });
  }

  return (
    <section className="panel">
      <h2>Classroom probe</h2>
      <p className="muted small">
        Testing whether this app is actually allowed to read Classroom. Step 1
        re-runs Google consent asking for the two read-only scopes; step 2
        calls the API with the resulting token.
      </p>

      <div className="row">
        <button onClick={connect}>1 · Grant Classroom access</button>
        <button onClick={callClassroom}>2 · Try reading courses</button>
      </div>

      {result.kind === "calling" && <p className="muted">Calling Classroom…</p>}

      {result.kind === "no-token" && (
        <p className="error">
          No provider token on the session. Either step 1 has not run, or the
          page was reloaded since — Supabase only exposes it right after the
          OAuth redirect. Run step 1 then step 2 without reloading.
        </p>
      )}

      {result.kind === "http-error" && (
        <>
          <p className="error">HTTP {result.status} — Classroom refused.</p>
          <pre className="pre">{result.body}</pre>
        </>
      )}

      {result.kind === "ok" && (
        <>
          <p className="ok">
            It works. {result.courses.length} active course
            {result.courses.length === 1 ? "" : "s"} returned.
          </p>
          <ul className="list">
            {result.courses.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

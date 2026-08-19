import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, signOut, ALLOWED_DOMAIN } from "./lib/supabase";
import { getConfig, getMe, ApiError } from "./lib/api";
import { rememberProviderToken } from "./lib/classroomHandoff";
import Login from "./pages/Login";
import Board from "./pages/Board";

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string; classroomEnabled: boolean }
  | { kind: "error"; message: string };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [backend, setBackend] = useState<BackendState>({ kind: "idle" });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      // Before setState, and on every event: this is the only place the
      // Google refresh token is ever visible, and it does not survive being
      // replaced by a session loaded from storage. See lib/classroomHandoff.
      rememberProviderToken(s);
      setSession(s);
      setLoadingSession(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // The domain check that matters lives in the backend and in RLS. This one
  // exists so someone who gets past the account picker sees an explanation
  // instead of an empty dashboard.
  const email = session?.user.email ?? "";
  const wrongDomain = Boolean(session) && !email.endsWith(`@${ALLOWED_DOMAIN}`);

  useEffect(() => {
    if (!session || wrongDomain) return;
    setBackend({ kind: "checking" });
    // Both in one round trip's worth of waiting: /config decides whether the
    // Connect Classroom button exists at all, and there is no point rendering
    // the dashboard twice for it.
    Promise.all([getMe(), getConfig()])
      .then(([me, config]) =>
        setBackend({
          kind: "ok",
          email: me.email,
          classroomEnabled: config.classroom_enabled,
        }),
      )
      .catch((e: unknown) =>
        setBackend({
          kind: "error",
          message: e instanceof ApiError ? e.message : "Could not reach the API",
        }),
      );
  }, [session, wrongDomain]);

  if (loadingSession) {
    return <p className="centered muted">Loading…</p>;
  }

  if (!session) {
    return <Login />;
  }

  if (wrongDomain) {
    return (
      <div className="centered">
        <h1>Wrong account</h1>
        <p className="muted">
          You signed in as <strong>{email}</strong>. This dashboard is for
          @{ALLOWED_DOMAIN} accounts.
        </p>
        <button onClick={() => signOut()}>Sign out and try again</button>
      </div>
    );
  }

  return <Board session={session} backend={backend} />;
}

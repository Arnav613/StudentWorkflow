import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, signOut, ALLOWED_DOMAIN } from "./lib/supabase";
import { getMe, ApiError } from "./lib/api";
import Login from "./pages/Login";
import Board from "./pages/Board";

type BackendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; email: string }
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
    getMe()
      .then((me) => setBackend({ kind: "ok", email: me.email }))
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

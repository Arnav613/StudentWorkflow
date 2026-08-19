import { useState } from "react";
import { signInWithGoogle, ALLOWED_DOMAIN } from "../lib/supabase";

export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    const { error } = await signInWithGoogle();
    if (error) {
      setError(error.message);
      setBusy(false);
    }
    // On success the browser navigates to Google, so there is no success
    // branch to handle here.
  }

  return (
    <div className="centered">
      <h1>Student Dashboard</h1>
      <p className="muted">
        Every deadline in one place. Sign in with your @{ALLOWED_DOMAIN}{" "}
        account.
      </p>
      <button onClick={handleSignIn} disabled={busy}>
        {busy ? "Redirecting…" : "Continue with Google"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

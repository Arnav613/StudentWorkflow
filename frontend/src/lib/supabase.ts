import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.",
  );
}

export const supabase = createClient(url, anonKey);

export const ALLOWED_DOMAIN = "ashoka.edu.in";

/**
 * Google sign-in, identity scopes only.
 *
 * Deliberately absent: the Classroom scopes. Ashoka IT has not allowlisted
 * this OAuth client for them, so requesting them here would make *every*
 * login fail for everyone — not degrade, fail. They get requested separately
 * in phase 05, from a Connect Classroom button, via incremental consent.
 *
 * `hd` asks Google to show only @ashoka.edu.in accounts in the picker. It is
 * a convenience, not a boundary — anyone can strip a query parameter. The
 * real check is on the verified email claim, in the backend and in the RLS
 * policies.
 *
 * access_type/prompt earn their keep only in phase 05, when we need a refresh
 * token. Harmless now, and one less thing to remember to add later.
 */
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
      queryParams: {
        hd: ALLOWED_DOMAIN,
        access_type: "offline",
        prompt: "consent",
      },
    },
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

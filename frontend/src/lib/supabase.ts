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
 * Deliberately absent: the Classroom scopes. They are requested separately,
 * from the Connect Classroom button below, via incremental consent. Not
 * because they are blocked — a probe proved they are not — but so that a
 * Classroom failure can never take down sign-in for everyone.
 *
 * `hd` asks Google to show only @ashoka.edu.in accounts in the picker. It is
 * a convenience, not a boundary — anyone can strip a query parameter. The
 * real check is on the verified email claim, in the backend and in the RLS
 * policies.
 *
 * access_type/prompt are here because Google issues a refresh token only when
 * asked. This one carries identity scopes only and is never stored — the
 * backend inspects the granted scopes and refuses it.
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

/**
 * The two Classroom scopes, read-only, requested on their own.
 *
 * courses.readonly lists the courses; coursework.me.readonly reads this
 * student's assignments and their own submission state. Nothing here can
 * write to Classroom, and nothing reads another student's work.
 */
export const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
].join(" ");

/** Set before the redirect, read after it. See lib/classroomHandoff.ts. */
export const CLASSROOM_PENDING_KEY = "classroom:connect-pending";

/**
 * Incremental consent for Classroom.
 *
 * `include_granted_scopes` keeps the identity grant the user already gave, so
 * this widens the existing consent rather than replacing it. `prompt=consent`
 * is not optional: without it Google skips the screen for a user who has
 * approved before and returns no refresh token at all — which is the one
 * thing this whole round trip exists to collect.
 *
 * The navigation is done here rather than by supabase-js. `skipBrowserRedirect`
 * hands back the URL instead of jumping to it, so a failure to build the URL
 * and a failure to leave the page are two distinguishable outcomes — a button
 * that silently does nothing is the worst possible version of this.
 */
export async function connectClassroom(): Promise<{ error: string | null }> {
  sessionStorage.setItem(CLASSROOM_PENDING_KEY, "1");

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      scopes: CLASSROOM_SCOPES,
      redirectTo: window.location.origin,
      skipBrowserRedirect: true,
      queryParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      },
    },
  });

  if (error || !data?.url) {
    // Nothing is going to happen, so do not leave a pending flag behind to
    // confuse the next page load.
    sessionStorage.removeItem(CLASSROOM_PENDING_KEY);
    return { error: error?.message ?? "Could not build the Google consent URL" };
  }

  window.location.assign(data.url);
  return { error: null };
}

import type { Session } from "@supabase/supabase-js";
import { CLASSROOM_PENDING_KEY } from "./supabase";
import { connectClassroomToken } from "./api";

/**
 * The narrow window in which a refresh token exists in the browser.
 *
 * Supabase puts `provider_refresh_token` on the session object returned by the
 * OAuth redirect and nowhere else — it is not in storage, and it is gone after
 * a reload. So the handoff has to happen on the auth state change itself,
 * before React has settled and before the user can refresh the page.
 *
 * Gated on a sessionStorage flag set by connectClassroom(). Ordinary sign-in
 * also produces a refresh token, but one carrying identity scopes only; the
 * backend would correctly reject it, and the user would see an error for
 * something they never asked to do.
 */
export type HandoffOutcome = "connected" | "skipped" | { error: string };

/**
 * The refresh token, grabbed the instant any auth event carries one.
 *
 * App loads the session two ways at once — `getSession()` and the
 * `onAuthStateChange` subscription — and only the second carries
 * `provider_refresh_token`. Whichever resolves last wins the React state, so
 * on a slow redirect return the token-bearing session can be overwritten by
 * a token-less one before the panel ever mounts. Then we would post nothing,
 * or worse, post the identity-only token left from ordinary sign-in and be
 * told the Classroom scopes are missing.
 *
 * So it is captured at the event, not read out of component state later.
 */
let capturedRefreshToken: string | null = null;

export function rememberProviderToken(session: Session | null): void {
  if (session?.provider_refresh_token) {
    capturedRefreshToken = session.provider_refresh_token;
  }
}

/**
 * Memoised for the lifetime of the page load.
 *
 * StrictMode runs effects twice in development, and this function consumes a
 * one-shot flag and a one-shot token. Running it twice means the second run
 * finds the flag already cleared and reports "skipped", throwing away the
 * first run's real result. Handing both callers the same promise makes the
 * double-invoke harmless instead of destructive.
 */
let inFlight: Promise<HandoffOutcome> | null = null;

export function handleClassroomRedirect(
  session: Session | null,
): Promise<HandoffOutcome> {
  inFlight ??= runHandoff(session);
  return inFlight;
}

async function runHandoff(session: Session | null): Promise<HandoffOutcome> {
  if (sessionStorage.getItem(CLASSROOM_PENDING_KEY) !== "1") return "skipped";

  const refreshToken = capturedRefreshToken ?? session?.provider_refresh_token;
  if (!refreshToken) {
    // Almost always prompt=consent being skipped by Google, or the user
    // closing the consent screen. Clearing the flag stops it retrying on
    // every subsequent auth event.
    sessionStorage.removeItem(CLASSROOM_PENDING_KEY);
    return {
      error:
        "Google did not return a refresh token. Try Connect again, and approve both Classroom permissions.",
    };
  }

  // Cleared before the request, not after: a failed handoff must not leave a
  // flag that re-fires on the next token refresh event.
  sessionStorage.removeItem(CLASSROOM_PENDING_KEY);

  try {
    await connectClassroomToken(refreshToken);
    return "connected";
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save the connection" };
  }
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  getClassroomStatus,
  isReconnectError,
  syncClassroom,
  type ConnectionStatus,
  type SyncReport,
} from "../lib/api";
import { connectClassroom } from "../lib/supabase";
import { handleClassroomRedirect } from "../lib/classroomHandoff";

function message(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

/**
 * Whether an app-open should pull from Classroom.
 *
 * Every load, whenever there is a live grant. There used to be a half-hour
 * staleness gate, on the theory that the hourly cron had probably just run
 * and a second round trip was waste. In practice the cost of being wrong is
 * asymmetric: a spare request to Google costs a few hundred milliseconds in
 * the background, while a deadline posted twenty minutes ago and not shown is
 * the one failure this app exists to prevent. Opening the app is the moment
 * someone is deciding what to do next, and it should be answered with what
 * Classroom holds now.
 *
 * Still not while disconnected, and not while the grant is known dead — the
 * reconnect banner is the fix for that, and an automatic sync that can only
 * fail would just decorate it with an error.
 */
function shouldSyncOnOpen(status: ConnectionStatus | null): boolean {
  return Boolean(status?.connected) && !status?.needs_reconnect;
}

/**
 * Everything the Classroom connection needs, in one place.
 *
 * `busy` deliberately covers status and sync together. Both hit Render, which
 * sleeps — so the first one of the day can take thirty seconds, and the
 * honest thing to show is one clear "working" state rather than two
 * independent spinners racing a cold start.
 */
export function useClassroom(session: Session, onSynced: () => void) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState<string | null>("Checking Classroom…");
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<ConnectionStatus | null> => {
    try {
      const next = await getClassroomStatus();
      setStatus(next);
      return next;
    } catch (e) {
      setError(message(e));
      return null;
    }
  }, []);

  const sync = useCallback(
    async (label = "Syncing with Classroom…") => {
      setBusy(label);
      setError(null);
      try {
        setReport(await syncClassroom());
        onSynced();
      } catch (e) {
        // A 409 is not an error to apologise for — the weekly token expiry in
        // Testing mode lands here. The panel renders it as a reconnect prompt.
        if (!isReconnectError(e)) setError(message(e));
      } finally {
        await refreshStatus();
        setBusy(null);
      }
    },
    [onSynced, refreshStatus],
  );

  // StrictMode invokes the effect below twice against the same component
  // instance, and a ref survives that. Without it both invocations see the
  // memoised handoff resolve to "connected" and each fires its own sync — two
  // imports racing each other into the same unique index.
  const started = useRef(false);

  // The handoff has to run before anything else touches the session, because
  // provider_refresh_token does not survive a reload. It no-ops unless the
  // Connect button set the pending flag before the redirect.
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const outcome = await handleClassroomRedirect(session);
        if (outcome === "connected") {
          // A fresh connection with nothing imported is not a connection the
          // user can see. Sync immediately so Connect ends in real classes.
          await sync("Importing your classes…");
          return;
        }
        if (typeof outcome === "object") setError(outcome.error);

        // Sync on app open, every time. The cron keeps the board current
        // while the app is closed; this is what makes it current the moment
        // it is opened.
        const current = await refreshStatus();
        if (shouldSyncOnOpen(current)) await sync("Checking for new coursework…");
      } catch (e) {
        setError(message(e));
      } finally {
        // Unconditionally. Every button on this panel is disabled while busy
        // is set, so any path that leaves it stuck presents as a dead panel.
        setBusy(null);
      }
    })();
    // Runs once per mount, on purpose. Re-running on every session refresh
    // would re-post a token that is long gone. The handoff itself is
    // memoised, so StrictMode's double-invoke is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setBusy("Opening Google…");
    try {
      const { error } = await connectClassroom();
      // On success the browser is already leaving for Google, so busy stays
      // set — there is no state worth restoring, and it stops a second click
      // racing the navigation.
      if (error) {
        setError(error);
        setBusy(null);
      }
    } catch (e) {
      setError(message(e));
      setBusy(null);
    }
  }, []);

  // No disconnect. Revoking this app's access is something Google offers in
  // one place for every app that has it, and a button here could only ever be
  // a worse copy of it — one that leaves the grant alive on Google's side
  // while the app claims otherwise. The endpoint is still there for anyone
  // who needs it; what is gone is a destructive control sitting permanently
  // under a class grid, where the only people who ever pressed it did so by
  // accident.
  return { status, report, busy, error, connect, sync, refreshStatus };
}

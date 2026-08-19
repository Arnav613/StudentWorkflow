import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  disconnectClassroom,
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

/** How stale the data has to be before opening the app triggers a sync. */
const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Whether an app-open should pull from Classroom.
 *
 * Not while disconnected, and not while the grant is known dead — the
 * reconnect banner is the fix for that, and an automatic sync that can only
 * fail would just decorate it with an error. Otherwise: only if the last
 * *successful* sync is older than half an hour. The hourly cron does the real
 * work; this exists for the gap between the last cron run and right now, and
 * for the user whose cron has never seen them because they just connected.
 *
 * A user who has never synced successfully has last_success_at of null, which
 * reads as infinitely stale — correct, that is exactly who most needs it.
 */
function shouldSyncOnOpen(status: ConnectionStatus | null): boolean {
  if (!status?.connected || status.needs_reconnect) return false;
  if (!status.last_success_at) return true;
  return Date.now() - Date.parse(status.last_success_at) > STALE_AFTER_MS;
}

/**
 * Everything the Connect Classroom panel needs, in one place.
 *
 * `busy` deliberately covers status, sync and disconnect together. All three
 * hit Render, which sleeps — so the first one of the day can take thirty
 * seconds, and the honest thing to show is one clear "working" state rather
 * than three independent spinners racing a cold start.
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

        // Sync on app open — but only when the hourly cron has not already
        // done it. Opening the app twice in ten minutes should not cost two
        // round trips to Google and a cold start; opening it after a night
        // asleep should show today's coursework without pressing anything.
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

  const disconnect = useCallback(async () => {
    setBusy("Disconnecting…");
    setError(null);
    try {
      await disconnectClassroom();
      setReport(null);
    } catch (e) {
      setError(message(e));
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  }, [refreshStatus]);

  return { status, report, busy, error, connect, sync, disconnect, refreshStatus };
}

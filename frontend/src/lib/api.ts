import { supabase } from "./supabase";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Fetch against our FastAPI backend with the Supabase access token attached.
 *
 * Render's free tier sleeps, and the first request after an idle period can
 * take thirty seconds or more. Callers must show a real loading state or the
 * first open of the day looks like the app is broken — so this does not
 * impose a short timeout that would turn a slow cold start into an error.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => b?.detail)
      .catch(() => null);
    throw new ApiError(res.status, detail ?? `Request failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

export type ClientConfig = {
  classroom_enabled: boolean;
  allowed_email_domain: string;
};

export const getConfig = () => api<ClientConfig>("/config");
export const getMe = () => api<{ id: string; email: string }>("/me");

// ---------------------------------------------------------------------------
// Classroom — phase 02
// ---------------------------------------------------------------------------

export type ConnectionStatus = {
  connected: boolean;
  needs_reconnect: boolean;
  connected_at: string | null;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
};

export type SyncReport = {
  courses_seen: number;
  classes_created: number;
  classes_linked: number;
  tasks_created: number;
  tasks_updated: number;
  tasks_adopted: number;
  tasks_skipped_submitted: number;
  tasks_auto_completed: number;
  tasks_auto_reopened: number;
  courses_skipped_dismissed: number;
  courses_skipped_term: number;
  warnings: string[];
};

export const getClassroomStatus = () =>
  api<ConnectionStatus>("/classroom/status");

/**
 * Hands the refresh token to the backend, once, and never again.
 *
 * This is the whole reason the backend exists in phase 02: Supabase exposes
 * provider_refresh_token on the session immediately after the OAuth redirect
 * and does not persist it, so a page reload loses it forever. That was the
 * probe's dead end.
 */
export const connectClassroomToken = (refresh_token: string) =>
  api<ConnectionStatus>("/classroom/connect", {
    method: "POST",
    body: JSON.stringify({ refresh_token }),
  });

export const syncClassroom = () =>
  api<SyncReport>("/classroom/sync", { method: "POST" });

export type ClassroomCourse = {
  id: string;
  name: string;
  section: string | null;
  /** Set when a class already points at this course. */
  linked_class_id: string | null;
};

/**
 * The courses behind the link picker on a new class.
 *
 * Hits Google, unlike /status, so it is fetched only when someone opens the
 * form that needs it — not on every app open.
 */
export const getClassroomCourses = () =>
  api<ClassroomCourse[]>("/classroom/courses");

/** 409 is the reconnect signal, not a failure. See routers/classroom.py. */
export const isReconnectError = (e: unknown) =>
  e instanceof ApiError && e.status === 409;

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
  /**
   * A key *and* the switch, decided on the server. False hides every AI
   * control rather than showing one that can only 503 — the same rule the
   * Connect Classroom button has followed since phase 02.
   */
  ai_enabled: boolean;
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
  /**
   * Connected and working, but the grant predates a permission the app now
   * asks for — today, Calendar. Not a failure: one feature is dark, and the
   * fix is the same Reconnect press, so it gets the same button and different
   * words.
   */
  needs_scopes: boolean;
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

// ---------------------------------------------------------------------------
// Calendar — phase 07. Times only; see backend/app/routers/calendar.py.
// ---------------------------------------------------------------------------

export type CalendarEvent = {
  id: string;
  /**
   * The recurring series this occurrence belongs to, or its own id.
   *
   * Empty from a backend older than phase 10, which callers fall back on the
   * event id for — one lecture linked individually is a worse answer than a
   * whole series, and a much better one than a crash.
   */
  series_id?: string;
  /** "Busy" when the event carries no summary we are allowed to see. */
  title: string;
  starts_at: string;
  ends_at: string;
};

export type CalendarResponse = {
  /**
   * False when the Calendar scope was never granted — which is every account
   * connected before phase 07 existed. Not an error: the planner simply
   * treats every waking hour as free and the Week page says so once, quietly.
   */
  granted: boolean;
  events: CalendarEvent[];
};

export const getCalendar = (days = 7) =>
  api<CalendarResponse>(`/calendar/events?days=${days}`);

// ---------------------------------------------------------------------------
// AI — phase 09. One route; the other model call runs inside sync, unwatched.
// ---------------------------------------------------------------------------

export type LinkSummary = {
  /** Set when there is a summary. Exactly one of these two is non-null. */
  summary: string | null;
  /**
   * Why there is not one, in a sentence meant to be shown as it is: a PDF, a
   * plain link, or a permission not granted. None of those is an error, and
   * rendering them in red would say the app is broken when it is not.
   */
  reason: string | null;
  generated_at: string | null;
};

export const summariseLink = (link_id: string) =>
  api<LinkSummary>("/ai/summarise-link", {
    method: "POST",
    body: JSON.stringify({ link_id }),
  });

// ---------------------------------------------------------------------------
// Reading an uploaded document — phase 10
// ---------------------------------------------------------------------------

export type ExtractedSession = {
  /** ISO, "YYYY-MM-DD". Every row the model could not date is already gone. */
  date: string;
  topic: string;
  details: string;
  is_assessment: boolean;
};

export type ExtractedCriterion = {
  label: string;
  weight: number;
  max_score: number;
};

/**
 * What a document seems to say — and nothing written down yet.
 *
 * This response is the whole of the model's involvement. It lands in React
 * state, renders as an editable table, and a person presses Confirm; the write
 * that follows is an ordinary browser-to-Supabase insert. Nothing here is
 * persisted server-side, so closing the tab discards it — which is right, and
 * cheap: the file is still uploaded and Extract is one press.
 *
 * `note` carries the honest empty case. A photograph of the wrong page finds
 * no rows, and that is a sentence to read rather than an error to be alarmed
 * by.
 */
export type Extraction = {
  kind: "timetable" | "rubric";
  title: string;
  sessions: ExtractedSession[];
  criteria: ExtractedCriterion[];
  note: string | null;
};

export const extractDocument = (document_id: string) =>
  api<Extraction>("/ai/extract", {
    method: "POST",
    body: JSON.stringify({ document_id }),
  });

// ---------------------------------------------------------------------------
// Arguing with the planner — phase 13
// ---------------------------------------------------------------------------

/**
 * One change to the week, of a kind a person could have made by hand.
 *
 * That is the whole rule in one type. Every `kind` below is something the
 * interface already offers: setting an estimate on a card, dragging a session
 * to another hour, pulling one off the grid, dropping an unplanned task onto a
 * day. There is deliberately no shape here for splitting a task, blacking out
 * an afternoon or pushing work into next week — those were things only the
 * model could do, and an edit nobody can perform by hand is one nobody can
 * undo by hand either.
 *
 * One flat shape rather than a discriminated union of four. It is rendered by
 * one list and applied by one switch; four types would cost more narrowing
 * than they buy.
 */
export type PlanEdit = {
  kind:
    // Work: one task, one hour.
    | "estimate"
    | "move_block"
    | "unplan_block"
    | "place_task"
    // Repeating blocks: the standing commitments that come back every week.
    | "add_routine"
    | "retime_routine"
    | "skip_routine_weekday"
    | "skip_routine_once"
    | "remove_routine";
  /** One clause naming the reason, shown beside the row before you accept. */
  why: string;
  task_id?: string | null;
  /** The block being moved or removed. Null on `estimate` and `place_task`. */
  block_id?: string | null;
  /** The repeating block being changed. Null on `add_routine`. */
  routine_id?: string | null;
  /** `add_routine` only. Everything else names something already there. */
  title?: string | null;
  /**
   * 0 is Sunday, matching `Date.getDay()`.
   *
   * Null carries meaning and a different one per kind: on `add_routine` it is
   * "every day", and on `retime_routine` it is "every day this already runs
   * on". Neither is a missing value.
   */
  weekday?: number | null;
  /** `"HH:MM"`, 24-hour. */
  time_of_day?: string | null;
  /** `"YYYY-MM-DD"` — the single occurrence `skip_routine_once` drops. */
  on_date?: string | null;
  minutes?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
};

/**
 * What was said, and what it would change — with nothing changed yet.
 *
 * No id, because there is nothing on the server to refer back to. The whole
 * exchange lives in React state and dies with the tab: rejecting is forgetting
 * and there is no row to mark rejected. See PLAN.md, phase 13.
 */
export type PlanAdvice = {
  message: string;
  edits: PlanEdit[];
};

export type PlanTurn = { role: "user" | "model"; text: string };

/**
 * Ask, with the whole conversation so far.
 *
 * The week itself is not sent. The backend reads it under the caller's own id,
 * because a request that carried its own task list would be a request that
 * could carry somebody else's. What does travel is the horizon — the browser
 * is the only party that knows which midnight the student is standing in —
 * and the Unplanned rail, whose ids are checked against that read.
 */
export const askPlanner = (body: {
  turns: PlanTurn[];
  from_at: string;
  to_at: string;
  unplaced: { task_id: string; minutes: number }[];
}) =>
  api<PlanAdvice>("/ai/plan", { method: "POST", body: JSON.stringify(body) });

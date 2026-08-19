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

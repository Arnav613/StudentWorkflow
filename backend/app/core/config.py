"""Settings, read once from the environment.

Nothing here has a usable default that touches a real service. If a secret is
missing the app should fail at import, not at the first request from a user.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# One .env for the whole project, at the repo root. Resolved from this file
# rather than the working directory, so `uvicorn` started from anywhere finds
# it. In deployment there is no file at all — Render injects real env vars,
# and a missing env_file is not an error.
ENV_FILE = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )

    # --- Supabase -----------------------------------------------------------
    supabase_url: str = ""
    # Server-side only. Bypasses RLS, so it must never reach the frontend.
    supabase_service_role_key: str = ""
    # Legacy HS256 signing secret. Only used for tokens whose header says
    # HS256; projects on asymmetric keys never need it. See core/auth.py.
    supabase_jwt_secret: str = ""

    # --- Access -------------------------------------------------------------
    allowed_email_domain: str = "ashoka.edu.in"

    # Vite dev server plus whatever Vercel gives us, comma separated.
    cors_origins: str = "http://localhost:5173"

    # --- Feature flags ------------------------------------------------------
    # Hides the Connect Classroom button and refuses connect/sync when off.
    # Lives on the server so a bad Google day is one env var on Render, not a
    # frontend redeploy. Default off: a deployment without Google credentials
    # should offer nothing rather than a button that 500s.
    classroom_enabled: bool = False

    # --- Classroom ----------------------------------------------------------
    google_client_id: str = ""
    google_client_secret: str = ""
    # Fernet key. Encrypts refresh tokens before they touch the database.
    token_encryption_key: str = ""

    # Only import courses whose name contains one of these, comma separated
    # and case-insensitive — e.g. "Monsoon 2026". Classroom has no notion of a
    # term, and professors leave years of courses unarchived, so the course
    # name is the only signal for which semester is the current one.
    #
    # Empty imports everything. This gates *new* imports only: a class you
    # already have keeps syncing, so narrowing the filter never silently
    # abandons a course you are actually taking.
    classroom_term_filter: str = ""


    # --- AI -----------------------------------------------------------------
    # Off by default, and reported to the browser through /config beside
    # classroom_enabled, so a deployment without a key hides the AI buttons
    # rather than showing ones that 500. A key present but the flag off means
    # off: the switch is the switch.
    ai_enabled: bool = False
    gemini_api_key: str = ""

    # Gemini's cheapest current model. Named here rather than in services/ai.py
    # so swapping it during a rate-limit afternoon is an env var on Render.
    #
    # It is also, as of August 2026, a value with a shelf life: 2.0-flash was
    # retired mid-term and every call started coming back 404 with Google
    # naming the successor in the error body. That is the failure to expect
    # here — not a wrong key and not a broken prompt — so when the AI features
    # go dark all at once, read the message before changing anything else.
    gemini_model: str = "gemini-3.6-flash"

    # --- Push ---------------------------------------------------------------
    # Web Push, for the morning digest. Off unless the flag and both VAPID
    # halves are present — the same "readiness, not the flag" rule as AI, and
    # for the same reason: a browser that is offered a notification prompt and
    # then cannot be delivered to has spent the one permission request it gets.
    #
    # The key pair identifies *this server* to Mozilla's and Google's push
    # services. Generate once with `python scripts/vapid.py` and never rotate
    # casually: the public half is baked into every subscription a browser has
    # already created, so a new pair invalidates every row in
    # push_subscriptions and every device has to be re-enabled by hand.
    push_enabled: bool = False
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    # A mailto: the push service can reach if this server starts misbehaving.
    # Required by the VAPID spec; some services reject pushes without it.
    vapid_subject: str = "mailto:gupta.arnav006@gmail.com"

    # Local hour at which the digest is sent, in each subscription's own
    # timezone. The GitHub Action ticks hourly and this is the hour it
    # matches, so moving the notification is one env var rather than a cron
    # expression in a workflow file.
    digest_hour: int = 8

    # --- Cron ---------------------------------------------------------------
    # Shared secret for POST /classroom/cron/sync. The hourly GitHub Action is
    # the only caller and has no user session to present, so this is the whole
    # authentication story for that one route. Empty disables the route
    # outright rather than leaving it open — a cron endpoint that authenticates
    # against an unset secret is an unauthenticated cron endpoint.
    cron_secret: str = ""

    @property
    def ai_ready(self) -> bool:
        """The flag *and* a key. Either alone is a promise the app cannot keep."""
        return self.ai_enabled and bool(self.gemini_api_key)

    @property
    def push_ready(self) -> bool:
        """The flag *and* both keys. See ai_ready — same rule, same reason."""
        return self.push_enabled and bool(self.vapid_public_key) and bool(self.vapid_private_key)

    @property
    def term_filters(self) -> list[str]:
        return [t.strip().casefold() for t in self.classroom_term_filter.split(",") if t.strip()]

    @property
    def supabase_jwks_url(self) -> str:
        """Where the public halves of the token signing keys are published.

        Derived rather than configured: it is fixed by the project URL, and a
        second env var would only ever be an opportunity to point token
        verification at the wrong project.
        """
        return self.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

"""Settings, read once from the environment.

Nothing here has a usable default that touches a real service. If a secret is
missing the app should fail at import, not at the first request from a user.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- Supabase -----------------------------------------------------------
    supabase_url: str = ""
    # Server-side only. Bypasses RLS, so it must never reach the frontend.
    supabase_service_role_key: str = ""
    # Used to verify the JWT the frontend sends us.
    supabase_jwt_secret: str = ""

    # --- Access -------------------------------------------------------------
    allowed_email_domain: str = "ashoka.edu.in"

    # Vite dev server plus whatever Vercel gives us, comma separated.
    cors_origins: str = "http://localhost:5173"

    # --- Feature flags ------------------------------------------------------
    # Phase 05. Off until Ashoka IT allowlists the OAuth client for the two
    # Classroom scopes. The code path exists and stays dark; see PLAN.md.
    classroom_enabled: bool = False

    # --- Classroom (phase 05, unused while the flag is off) -----------------
    google_client_id: str = ""
    google_client_secret: str = ""
    # Fernet key. Encrypts refresh tokens before they touch the database.
    token_encryption_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

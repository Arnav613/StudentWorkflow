"""Health and identity — the two routes phase 00 needs to prove itself.

/health is also what the hourly GitHub Action pings to wake Render before the
real sync call, once phase 04's cron exists.
"""

from fastapi import APIRouter, Depends

from app.core.auth import CurrentUser, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter()


@router.get("/health")
def health() -> dict:
    """Unauthenticated on purpose: the cron wake-up call has no user."""
    return {"status": "ok"}


@router.get("/config")
def client_config(settings: Settings = Depends(get_settings)) -> dict:
    """Flags the frontend needs before it can decide what to render.

    `classroom_enabled` is the switch that reveals the Connect Classroom
    button. It lives on the server so turning it off during a Google outage
    is an env var on Render, not a frontend redeploy.

    `ai_enabled` is the same idea for phase 09, and it reports readiness
    rather than the flag: a deployment with the switch on and no Gemini key
    would otherwise show a Summarise button that can only ever 503.
    """
    return {
        "classroom_enabled": settings.classroom_enabled,
        "ai_enabled": settings.ai_ready,
        "allowed_email_domain": settings.allowed_email_domain,
    }


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Proves the whole chain: Google -> Supabase -> our JWT check."""
    return {"id": user.id, "email": user.email}

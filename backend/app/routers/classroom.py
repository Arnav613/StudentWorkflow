"""Connect, sync, status, disconnect, and the course list behind the link picker.

Why the refresh token arrives in a request body rather than being fetched by
this server: Supabase already ran the OAuth dance, and it surfaces
`provider_refresh_token` on the session exactly once, in the browser, right
after the redirect. Running a second, parallel OAuth flow here to obtain the
same grant would mean a second redirect URI, a second consent screen, and two
code paths that can disagree about who is signed in. So the browser hands the
token over immediately and forgets it; from that point on it lives encrypted,
server-side, and the browser never sees it again.

The token is not trusted on arrival. `/classroom/connect` spends it against
Google before storing anything, which proves it is real, that it belongs to
our OAuth client, and — from the `scope` Google returns — that the user
actually granted both Classroom scopes rather than unticking one.
"""

import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from app.core import supabase as db
from app.core.auth import CurrentUser, get_current_user
from app.core.config import Settings, get_settings
from app.core.crypto import TokenCryptoError, encrypt
from app.services import classroom_sync, google

router = APIRouter(prefix="/classroom")


class ConnectRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class ConnectionStatus(BaseModel):
    connected: bool
    needs_reconnect: bool
    connected_at: str | None = None
    last_sync_at: str | None = None
    last_success_at: str | None = None
    last_error: str | None = None


def _require_enabled(settings: Settings = Depends(get_settings)) -> Settings:
    if not settings.classroom_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Classroom sync is turned off on this deployment",
        )
    return settings


# 409 is the reconnect banner's signal. It is a routine weekly event in
# Testing mode, not a failure, and the frontend renders it as a prompt.
RECONNECT = status.HTTP_409_CONFLICT


@router.post("/connect", response_model=ConnectionStatus)
async def connect(
    body: ConnectRequest,
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> ConnectionStatus:
    try:
        access = await google.exchange_refresh_token(body.refresh_token)
    except google.ReconnectRequired as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Google rejected that grant: {exc}",
        ) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    if not access.has_classroom_scopes():
        # The ordinary sign-in also produces a refresh token, with identity
        # scopes only. Storing that one would leave the user "connected" and
        # every sync failing with a 403 they cannot explain.
        missing = [" or ".join(g) for g in google.missing_scope_groups(access.scopes)]
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Classroom permissions were not granted. Press Connect again "
                "and tick both Classroom boxes on the Google screen. "
                f"Google granted: {' '.join(access.scopes) or '(nothing)'}. "
                f"Missing: {' '.join(missing)}"
            ),
        )

    try:
        ciphertext = encrypt(body.refresh_token)
    except TokenCryptoError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc

    rows = await db.upsert_on(
        "google_tokens",
        {
            "user_id": user.id,
            "refresh_token_enc": ciphertext,
            "scopes": list(access.scopes),
            "needs_reconnect": False,
        },
        conflict="user_id",
    )
    row = rows[0] if rows else {}
    return ConnectionStatus(
        connected=True,
        needs_reconnect=False,
        connected_at=row.get("connected_at"),
    )


@router.get("/status", response_model=ConnectionStatus)
async def connection_status(
    user: CurrentUser = Depends(get_current_user),
) -> ConnectionStatus:
    """Cheap on purpose — no call to Google.

    This runs on every app open, and the frontend needs it before it can
    decide between Connect, Sync now, and the reconnect banner. Whether the
    grant is still good is answered by the next sync, not by a round trip
    here.
    """
    tokens = await db.select("google_tokens", user_id=db.eq(user.id))
    state = await db.select("sync_state", user_id=db.eq(user.id))
    token = tokens[0] if tokens else None
    s = state[0] if state else {}

    return ConnectionStatus(
        connected=token is not None,
        needs_reconnect=bool(token and token.get("needs_reconnect")),
        connected_at=token.get("connected_at") if token else None,
        last_sync_at=s.get("last_sync_at"),
        last_success_at=s.get("last_success_at"),
        last_error=s.get("last_error"),
    )


class Course(BaseModel):
    id: str
    name: str
    section: str | None = None
    """The class row already pointing at this course, if there is one."""
    linked_class_id: str | None = None


@router.get("/courses", response_model=list[Course])
async def list_courses(
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> list[Course]:
    """The user's Classroom courses, for the link picker on a new class.

    Deliberately unfiltered by term, unlike sync. The term filter exists to
    stop a sync importing four years of archived courses unasked; this list is
    something a person opened on purpose and read, and hiding the course they
    are looking for because its name lacks a substring would be a bug they
    could not diagnose.

    Dismissed courses are not filtered either. A tombstone means "stop
    importing this automatically" — it was never meant to override someone
    explicitly asking for that course by name.
    """
    try:
        token = await classroom_sync.get_access_token(user.id)
        courses = await google.list_courses(token)
    except google.ReconnectRequired as exc:
        raise HTTPException(status_code=RECONNECT, detail=str(exc)) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    rows = await db.select("classes", user_id=db.eq(user.id))
    linked = {c["google_course_id"]: c["id"] for c in rows if c["google_course_id"]}

    return [
        Course(
            id=c["id"],
            name=c.get("name") or "Untitled course",
            section=c.get("section"),
            linked_class_id=linked.get(c["id"]),
        )
        for c in courses
    ]


@router.post("/sync")
async def sync_now(
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> dict:
    """The refresh button, and the on-open sync. One user, right now."""
    try:
        report = await classroom_sync.sync_user(user.id)
    except google.ReconnectRequired as exc:
        raise HTTPException(
            status_code=RECONNECT,
            detail=f"Classroom needs reconnecting: {exc}",
        ) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return report.as_dict()


@router.delete("/disconnect")
async def disconnect(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Drops the stored grant and nothing else.

    Imported classes and tasks stay: they are the user's data now, and a
    disconnect that silently deleted a semester of deadlines would be a much
    worse surprise than a few rows that stop updating.
    """
    await db.delete("google_tokens", user_id=db.eq(user.id))
    return {"disconnected": True}


@router.post("/cron/sync")
async def cron_sync(
    x_cron_secret: str = Header(default=""),
    settings: Settings = Depends(_require_enabled),
) -> dict:
    """Every connected user. Called hourly by GitHub Actions.

    Authenticated by a shared secret rather than a bearer token, because the
    caller is a workflow, not a person — there is no session to present and no
    user to attribute the run to. `compare_digest` rather than `==`: the
    comparison is against a secret, and the timing of a naive one leaks it a
    byte at a time.

    Deliberately not a background task. The Action needs the run's exit status
    to be the run's actual outcome — a 202 and a fire-and-forget coroutine on
    a dyno that sleeps the moment the response is sent would report success
    for work that never happened.
    """
    if not settings.cron_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="CRON_SECRET is not configured; the cron route is disabled",
        )
    if not secrets.compare_digest(x_cron_secret, settings.cron_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad cron secret"
        )

    fleet = await classroom_sync.sync_all()
    return fleet.as_dict()

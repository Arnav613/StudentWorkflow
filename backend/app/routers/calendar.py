"""Busy intervals, and nothing else.

This is the only route in the app that touches Google Calendar, it is
read-only, and it is narrower than read-only: it returns start/end pairs. No
event title, description, location or guest list is requested, received,
logged or stored — see `google.list_busy`, which uses freeBusy precisely
because that endpoint cannot return those things even by accident.

No write path exists here. PLAN.md reversed "no Calendar integration" to
"read-only" on exactly that condition: the planner has to know which hours are
taken, and a calendar this app can write to is a calendar that has to be
reconciled in two places the next time a meeting moves.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import CurrentUser, get_current_user
from app.core.config import Settings, get_settings
from app.services import classroom_sync, google

router = APIRouter(prefix="/calendar")

# Same 409 contract as Classroom: a dead grant is a prompt, not a crash.
RECONNECT = status.HTTP_409_CONFLICT

# The planner never looks further ahead than a fortnight, and phase 08's
# forecast is fourteen days by design. A cap here stops a hand-edited query
# string asking Google for a decade.
MAX_DAYS = 21


class BusyInterval(BaseModel):
    starts_at: str
    ends_at: str


class BusyResponse(BaseModel):
    """Whether we may look, and what we saw.

    `granted` is false rather than an error when the user has not given the
    Calendar scope. Everyone connected before phase 07 is in that position —
    their grant predates the scope existing — and the planner works without
    it, simply assuming every waking hour is free. A 403 here would put a red
    error on a week that is otherwise perfectly correct.
    """

    granted: bool
    busy: list[BusyInterval] = []


def _require_enabled(settings: Settings = Depends(get_settings)) -> Settings:
    """Gated on the same flag as Classroom, because it is the same connection.

    There is one Google grant per user and one place it is stored. A separate
    calendar_enabled switch would be a second flag that could disagree with
    the first about whether the app talks to Google at all.
    """
    if not settings.classroom_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google integration is turned off on this deployment",
        )
    return settings


@router.get("/busy", response_model=BusyResponse)
async def busy(
    days: int = Query(default=7, ge=1, le=MAX_DAYS),
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> BusyResponse:
    """The next `days` days of occupied time, from now.

    From now, not from midnight: hours that have already passed cannot be
    planned into, so asking about them would only widen the query.
    """
    start = datetime.now(timezone.utc)
    end = start + timedelta(days=days)

    try:
        grant = await classroom_sync.get_access_grant(user.id)
    except google.ReconnectRequired as exc:
        raise HTTPException(status_code=RECONNECT, detail=str(exc)) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    # Checked before the call, not after a 403. Google's refusal and a scope
    # the user simply never granted look identical from the response body, and
    # only one of them is worth telling anyone about.
    if google.CALENDAR_SCOPE not in grant.scopes:
        return BusyResponse(granted=False)

    try:
        rows = await google.list_busy(grant.token, start, end)
    except google.ReconnectRequired as exc:
        raise HTTPException(status_code=RECONNECT, detail=str(exc)) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return BusyResponse(
        granted=True,
        busy=[
            BusyInterval(starts_at=r["start"], ends_at=r["end"])
            for r in rows
            if r.get("start") and r.get("end")
        ],
    )

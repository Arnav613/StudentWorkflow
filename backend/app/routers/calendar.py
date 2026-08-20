"""The user's calendar, read-only, as titles and times.

This is the only route in the app that touches Google Calendar and it is
read-only in the strict sense: there is no write path anywhere in this file or
in `google.list_events`, so a calendar this app can read is a calendar it
cannot damage. PLAN.md reversed "no Calendar integration" to "read-only" on
exactly that condition — a calendar this app could write to would need
reconciling in two places the next time a meeting moved.

It reads events rather than free/busy, and therefore *does* receive event
titles, which reach the browser so the week can say "Econ lecture" instead of
"Busy". An earlier version used freeBusy, which returns start/end pairs and is
structurally incapable of returning a title; that was the stronger privacy
position and it made the calendar invisible on the grid, which by this app's
own rule — never let silence look like a bug — was the worse failure. Titles
are the deliberate trade. Descriptions, locations, attendees and organisers
are still neither requested nor passed on.
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


class CalendarEvent(BaseModel):
    id: str
    title: str
    starts_at: str
    ends_at: str


class CalendarResponse(BaseModel):
    """Whether we may look, and what we saw.

    `granted` is false rather than an error when the user has not given the
    Calendar scope. Everyone connected before phase 07 is in that position —
    their grant predates the scope existing — and the planner works without
    it, simply assuming every waking hour is free. A 403 here would put a red
    error on a week that is otherwise perfectly correct.
    """

    granted: bool
    events: list[CalendarEvent] = []


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


@router.get("/events", response_model=CalendarResponse)
async def events(
    days: int = Query(default=7, ge=1, le=MAX_DAYS),
    user: CurrentUser = Depends(get_current_user),
    _: Settings = Depends(_require_enabled),
) -> CalendarResponse:
    """The next `days` days of committed time, from now.

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
        return CalendarResponse(granted=False)

    try:
        rows = await google.list_events(grant.token, start, end)
    except google.ReconnectRequired as exc:
        raise HTTPException(status_code=RECONNECT, detail=str(exc)) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return CalendarResponse(
        granted=True,
        events=[CalendarEvent(**r) for r in rows],
    )

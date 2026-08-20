"""Google: turning a stored refresh token into live Classroom data.

Access tokens are never persisted. They last an hour, a sync takes seconds,
and a token we do not store is a token that cannot leak. Every sync starts by
spending the refresh token for a fresh one.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.config import get_settings

TOKEN_URL = "https://oauth2.googleapis.com/token"
CLASSROOM = "https://classroom.googleapis.com/v1"
CALENDAR = "https://www.googleapis.com/calendar/v3"

COURSES_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly"
COURSEWORK_SCOPE = "https://www.googleapis.com/auth/classroom.coursework.me.readonly"
# Google's older name for the very same consent item — "View your course work
# and grades in Google Classroom". Ask for coursework.me.readonly and the token
# endpoint hands back student-submissions.me.readonly instead. Checking the
# requested string alone rejects a grant that is in fact complete.
SUBMISSIONS_SCOPE = (
    "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly"
)

# Read-only, and phase 07 asks for it without adding it to the required set
# below. Existing refresh tokens carry only the scopes they were granted, so
# adding it here would put every already-connected user into the reconnect
# banner today for a feature that degrades perfectly well without it. Phase 09
# adds it, and its announcement scopes, in one re-consent — see PLAN.md.
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

# Each group is one permission we need, listed as the names Google might use
# for it. A grant satisfies us when it covers every group.
REQUIRED_SCOPE_GROUPS = (
    (COURSES_SCOPE,),
    (COURSEWORK_SCOPE, SUBMISSIONS_SCOPE),
)


def missing_scope_groups(scopes: tuple[str, ...]) -> list[tuple[str, ...]]:
    return [g for g in REQUIRED_SCOPE_GROUPS if not any(s in scopes for s in g)]


class ReconnectRequired(Exception):
    """Google rejected the refresh token; only the user can fix this.

    In Testing mode Google expires refresh tokens after seven days, so this is
    a routine weekly event rather than an error condition. It raises the
    reconnect banner; it must never read as a crash.
    """


class ClassroomError(RuntimeError):
    """Google answered, but not with what we asked for."""


@dataclass(frozen=True)
class AccessToken:
    token: str
    scopes: tuple[str, ...]

    def has_classroom_scopes(self) -> bool:
        return not missing_scope_groups(self.scopes)


async def exchange_refresh_token(refresh_token: str) -> AccessToken:
    """Spend a refresh token for an access token, and learn what it can do.

    The `scope` in the response is the authority on what the user actually
    granted — Supabase's session does not tell us, and the consent screen lets
    a user untick things. It is what the connect endpoint checks before
    agreeing to store anything.
    """
    settings = get_settings()
    async with httpx.AsyncClient(timeout=30.0) as http:
        res = await http.post(
            TOKEN_URL,
            data={
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )

    if res.status_code == 400 or res.status_code == 401:
        # invalid_grant: expired, revoked, or issued to a different client.
        raise ReconnectRequired(res.text)
    if res.status_code >= 400:
        raise ClassroomError(f"Token exchange failed ({res.status_code}): {res.text}")

    body = res.json()
    return AccessToken(
        token=body["access_token"],
        scopes=tuple(body.get("scope", "").split()),
    )


async def _get_all(
    http: httpx.AsyncClient, path: str, key: str, **params: Any
) -> list[dict]:
    """One Classroom collection, following pageToken to the end.

    Six courses will never paginate. Coursework for a full semester can, and a
    silently truncated first page would look exactly like a professor who
    forgot to post an assignment.
    """
    out: list[dict] = []
    page: str | None = None
    while True:
        q = dict(params, pageSize=100)
        if page:
            q["pageToken"] = page
        res = await http.get(path, params=q)
        if res.status_code == 403:
            raise ClassroomError(
                "Classroom refused the request (403). The account may not have "
                f"Classroom access, or the API is not enabled: {res.text}"
            )
        if res.status_code == 401:
            raise ReconnectRequired(res.text)
        if res.status_code >= 400:
            raise ClassroomError(f"{path} -> {res.status_code}: {res.text}")
        body = res.json()
        out.extend(body.get(key, []))
        page = body.get("nextPageToken")
        if not page:
            return out


def _api(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=CLASSROOM,
        headers={"Authorization": f"Bearer {token}"},
        timeout=60.0,
    )


async def list_courses(token: str) -> list[dict]:
    """Non-archived courses only.

    ACTIVE is the whole point: professors routinely never archive last
    semester, so this is filtered by state and the leftovers are then hidden
    by hand in the UI.
    """
    async with _api(token) as http:
        return await _get_all(http, "/courses", "courses", courseStates="ACTIVE")


async def list_coursework(token: str, course_id: str) -> list[dict]:
    async with _api(token) as http:
        return await _get_all(
            http,
            f"/courses/{course_id}/courseWork",
            "courseWork",
            courseWorkStates="PUBLISHED",
        )


async def list_submissions(token: str, course_id: str) -> dict[str, str]:
    """Submission state per coursework id, for one course, in one call.

    The `-` wildcard stands in for "every courseWork in this course", which
    turns what would be one request per assignment into one per course.
    Returns e.g. {"12345": "TURNED_IN"}.
    """
    async with _api(token) as http:
        rows = await _get_all(
            http,
            f"/courses/{course_id}/courseWork/-/studentSubmissions",
            "studentSubmissions",
            userId="me",
        )
    return {r["courseWorkId"]: r.get("state", "NEW") for r in rows if "courseWorkId" in r}


SUBMITTED_STATES = {"TURNED_IN", "RETURNED"}


def due_at(coursework: dict) -> datetime | None:
    """Classroom's split date/time fields, as one UTC instant.

    Coursework with no due date is not a deadline, and the app is deadlines
    first — callers skip anything that returns None. A missing dueTime means
    "end of that day" in Google's model, so it becomes 23:59 rather than
    midnight, which would land the task a day early.
    """
    d = coursework.get("dueDate")
    if not d or "year" not in d:
        return None
    t = coursework.get("dueTime") or {"hours": 23, "minutes": 59}
    return datetime(
        d["year"],
        d["month"],
        d["day"],
        t.get("hours", 0),
        t.get("minutes", 0),
        tzinfo=timezone.utc,
    )


# ---------------------------------------------------------------------------
# Calendar — read-only, and narrower than read-only.
# ---------------------------------------------------------------------------


async def list_busy(token: str, start: datetime, end: datetime) -> list[dict]:
    """Which intervals are already taken, between two instants.

    freeBusy, not events.list, and the difference is the entire point. The
    planner needs to know that Tuesday 2–4pm is gone; it does not need to know
    it is gone because of a doctor's appointment. freeBusy answers exactly the
    first question and is structurally incapable of answering the second, so
    no event title, description, location or attendee ever leaves Google — not
    because this code chooses not to log them, but because it never receives
    them.

    There is no write path in this file. A calendar the app cannot write to is
    a calendar it cannot corrupt, and a last-minute meeting then needs
    reconciling in one place instead of two.
    """
    async with httpx.AsyncClient(
        base_url=CALENDAR,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0,
    ) as http:
        res = await http.post(
            "/freeBusy",
            json={
                "timeMin": start.astimezone(timezone.utc).isoformat(),
                "timeMax": end.astimezone(timezone.utc).isoformat(),
                # "primary" is the calendar the user actually lives in.
                # Enumerating every subscribed calendar would drag in holidays,
                # birthdays and a shared timetable nobody meant to plan around.
                "items": [{"id": "primary"}],
            },
        )

    if res.status_code == 401:
        raise ReconnectRequired(res.text)
    if res.status_code == 403:
        raise ClassroomError(
            "Calendar refused the request (403). The Calendar API may not be "
            f"enabled for this project: {res.text}"
        )
    if res.status_code >= 400:
        raise ClassroomError(f"freeBusy -> {res.status_code}: {res.text}")

    body = res.json()
    calendar = (body.get("calendars") or {}).get("primary") or {}
    # Google reports per-calendar errors inside a 200. A "notFound" here means
    # the account has no primary calendar, which is not an error worth raising
    # — it is an empty week, and the planner handles that fine.
    return calendar.get("busy", [])

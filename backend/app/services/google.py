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

CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

# Each group is one permission we need, listed as the names Google might use
# for it. A grant satisfies us when it covers every group.
#
# Required means required: without these the app has nothing to sync, so
# /classroom/connect refuses a grant that lacks one rather than storing a
# connection every sync will fail behind.
REQUIRED_SCOPE_GROUPS = (
    (COURSES_SCOPE,),
    (COURSEWORK_SCOPE, SUBMISSIONS_SCOPE),
)

# Asked for, and used when present, but never a condition of connecting.
#
# Calendar is not in REQUIRED above on purpose: unticking it on the Google
# screen should cost you the planner's knowledge of your lectures, never your
# Classroom connection, and /calendar/busy already answers `granted: false`
# instead of failing. What it does do is raise the reconnect prompt for a
# grant that predates it — which is how a new permission reaches an existing
# user without a button of its own. Phase 09's scopes join this tuple.
OPTIONAL_SCOPE_GROUPS = ((CALENDAR_SCOPE,),)


def _missing(groups: tuple, scopes: tuple[str, ...]) -> list[tuple[str, ...]]:
    return [g for g in groups if not any(s in scopes for s in g)]


def missing_scope_groups(scopes: tuple[str, ...]) -> list[tuple[str, ...]]:
    return _missing(REQUIRED_SCOPE_GROUPS, scopes)


def missing_optional_scopes(scopes: tuple[str, ...]) -> list[tuple[str, ...]]:
    """Permissions the app now asks for that this grant was issued before.

    Drives the reconnect prompt, not an error. A grant missing one of these
    works — it just works with less.
    """
    return _missing(OPTIONAL_SCOPE_GROUPS, scopes)


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
# Calendar — read-only, and read-only is the whole of the guarantee.
# ---------------------------------------------------------------------------


def _is_busy(event: dict) -> bool:
    """Whether an event actually occupies the time it sits on.

    Four things on a calendar are not a commitment, and treating them as one
    would carve holes out of a week that is genuinely free:

    Events marked Free. `transparency: "transparent"` is Google's own word for
    "this is on my calendar but I am available", which is precisely the
    question being asked here.

    All-day events. A holiday or a term marker is a label on a day, not
    twenty-four hours of occupation, and reading one as busy would delete a
    whole column from the plan.

    Invitations you declined. A meeting you said no to is not a meeting.

    Cancelled events, which `singleEvents` can still return.
    """
    if event.get("status") == "cancelled":
        return False
    if event.get("transparency") == "transparent":
        return False
    if not (event.get("start") or {}).get("dateTime"):
        return False
    for attendee in event.get("attendees") or []:
        if attendee.get("self") and attendee.get("responseStatus") == "declined":
            return False
    return True


async def list_events(token: str, start: datetime, end: datetime) -> list[dict]:
    """The user's own events between two instants, as title and times.

    This reads events, not free/busy. It therefore receives event titles, and
    they reach the browser so the week grid can say "Econ lecture" rather than
    "Busy" — which is the whole reason for reading events at all, and is a
    deliberate widening of what the earlier freeBusy version could see.

    What has not changed, and is the actual guarantee: there is no write path
    in this file. Nothing here can create, move or delete an event, so a
    calendar this app can read is still a calendar it cannot damage — and a
    meeting that moves needs reconciling in one place, not two.

    Only the primary calendar. Enumerating everything subscribed would drag in
    holidays, birthdays and a shared timetable nobody meant to plan around.

    `singleEvents` expands a recurring event into its actual occurrences.
    Without it a weekly seminar arrives as one master row with a recurrence
    rule this code would have to interpret itself — a second implementation of
    something Google already does correctly.
    """
    out: list[dict] = []
    page: str | None = None

    async with httpx.AsyncClient(
        base_url=CALENDAR,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0,
    ) as http:
        while True:
            params: dict[str, Any] = {
                "timeMin": start.astimezone(timezone.utc).isoformat(),
                "timeMax": end.astimezone(timezone.utc).isoformat(),
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": 250,
            }
            if page:
                params["pageToken"] = page

            res = await http.get("/calendars/primary/events", params=params)

            if res.status_code == 401:
                raise ReconnectRequired(res.text)
            if res.status_code == 403:
                raise ClassroomError(
                    "Calendar refused the request (403). The Calendar API may "
                    f"not be enabled for this project: {res.text}"
                )
            if res.status_code == 404:
                # No primary calendar on the account. An empty week, not an
                # error — the planner handles that perfectly well.
                return []
            if res.status_code >= 400:
                raise ClassroomError(f"events -> {res.status_code}: {res.text}")

            body = res.json()
            for event in body.get("items", []):
                if not _is_busy(event):
                    continue
                out.append(
                    {
                        "id": event.get("id", ""),
                        # A private event on a shared calendar comes back with
                        # no summary at all. "Busy" is the honest rendering of
                        # a thing we know occupies time and nothing else.
                        "title": event.get("summary") or "Busy",
                        "starts_at": event["start"]["dateTime"],
                        "ends_at": event["end"]["dateTime"],
                    }
                )

            page = body.get("nextPageToken")
            if not page:
                return out

"""The morning digest: one notification, once a day, per device.

Deliberately the *only* reminder this app sends. A per-task alert an hour
before each deadline is the obvious feature and the wrong one — a week with
eleven deadlines is eleven interruptions, and the eleventh is swiped away
without being read. One notification at eight, saying what today holds, is a
thing a person can act on before they have put their phone down.

Timing lives with the *subscription*, not with the server's clock. The job is
woken hourly and each device is asked whether it is 8am where it is. That
costs 24 wake-ups a day on a free tier that does not charge for them, and it
means one person on exchange in Berlin gets a Berlin morning without a second
scheduler.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core import supabase as db
from app.core.config import get_settings
from app.services import push

log = logging.getLogger(__name__)

UTC = ZoneInfo("UTC")


@dataclass
class Report:
    """What the cron run did, in the shape the Action prints."""

    considered: int = 0
    sent: int = 0
    skipped_wrong_hour: int = 0
    skipped_nothing_due: int = 0
    expired: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "considered": self.considered,
            "sent": self.sent,
            "skipped_wrong_hour": self.skipped_wrong_hour,
            "skipped_nothing_due": self.skipped_nothing_due,
            "expired": self.expired,
            "errors": self.errors,
        }


def _zone(name: str) -> ZoneInfo:
    """The subscription's timezone, or Delhi if it names one Python lacks."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        log.warning("Unknown timezone %r on a subscription; using Asia/Kolkata", name)
        return ZoneInfo("Asia/Kolkata")


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    # PostgREST hands back ISO 8601 with a +00:00 offset, but a bare Z shows
    # up depending on how the column was written.
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _due_soon(
    user_id: str, now_local: datetime, tz: ZoneInfo
) -> tuple[list[dict], list[dict], list[dict]]:
    """Overdue, due today, due tomorrow — for one user, in their own day.

    One query, bucketed in Python. The bucketing has to happen here anyway
    because "today" is a local-calendar question and the column is a UTC
    instant, and the row count for one student's open coursework is small
    enough that filtering the far edge in the database would buy nothing.
    """
    today = now_local.date()
    # A fortnight back is enough to say "3 overdue" without dragging in a task
    # from September that was abandoned rather than missed.
    floor = (now_local - timedelta(days=14)).astimezone(UTC)

    rows = await db.select(
        "tasks",
        user_id=db.eq(user_id),
        status="neq.done",
        archived_at="is.null",
        due_at=f"gte.{floor.isoformat()}",
    )

    overdue: list[dict] = []
    due_today: list[dict] = []
    tomorrow: list[dict] = []

    for row in rows:
        due = _parse(row.get("due_at"))
        if due is None:
            continue
        day = due.astimezone(tz).date()
        if day < today:
            overdue.append(row)
        elif day == today:
            due_today.append(row)
        elif day == today + timedelta(days=1):
            tomorrow.append(row)

    for bucket in (overdue, due_today, tomorrow):
        bucket.sort(key=lambda r: r.get("due_at") or "")
    return overdue, due_today, tomorrow


def _compose(
    overdue: list[dict], today: list[dict], tomorrow: list[dict]
) -> dict | None:
    """The notification, or None when there is nothing worth waking a phone for.

    Silence is a feature. A morning with nothing due should produce no
    notification at all — "0 tasks due today" every Sunday for a term is how a
    person learns to ignore this app's notifications, and then misses the one
    that mattered.

    The title carries the count and the body names the work, because a lock
    screen shows the title in full and truncates the body. Two or three titles
    are named individually; past that the count is the useful part and the
    names are noise.
    """
    if not overdue and not today:
        # Tomorrow alone is not urgent enough to be a notification. It shows on
        # the board, which is where a person looks when they open the app.
        return None

    def names(rows: list[dict], limit: int = 2) -> str:
        titles = [str(r.get("title") or "Untitled").strip() for r in rows]
        if len(titles) <= limit:
            return " · ".join(titles)
        return " · ".join(titles[:limit]) + f" and {len(titles) - limit} more"

    if today and overdue:
        title = f"{len(today)} due today, {len(overdue)} overdue"
        body = names(today)
    elif today:
        title = "1 due today" if len(today) == 1 else f"{len(today)} due today"
        body = names(today, limit=3)
    else:
        title = "1 overdue" if len(overdue) == 1 else f"{len(overdue)} overdue"
        body = names(overdue, limit=3)

    if tomorrow:
        body = f"{body}\n{len(tomorrow)} due tomorrow"

    return {
        "title": title,
        "body": body,
        "tag": "digest",
        # The week is the screen that answers "so what do I do now" — the
        # board is a list, the week is a plan.
        "url": "/#/week",
    }


async def run(*, force_user: str | None = None) -> Report:
    """Every subscription that wants a digest, checked against its own clock.

    `force_user` ignores the hour for one person and is what POST /push/test
    uses, so a person can prove notifications work at four in the afternoon
    rather than by waiting until tomorrow to find out they do not.
    """
    settings = get_settings()
    report = Report()

    filters = {"digest": "is.true"}
    if force_user:
        filters["user_id"] = db.eq(force_user)
    subs = await db.select("push_subscriptions", **filters)
    report.considered = len(subs)

    # Users repeat across devices — a phone and a laptop share a digest. The
    # tasks query is per user, so it runs once and both devices are served
    # from it.
    cache: dict[str, dict | None] = {}

    for sub in subs:
        tz = _zone(sub.get("timezone") or "Asia/Kolkata")
        now_local = datetime.now(tz)

        if force_user is None and now_local.hour != settings.digest_hour:
            report.skipped_wrong_hour += 1
            continue

        user_id = sub["user_id"]
        # Keyed on the local date too: two devices in different timezones can
        # legitimately be on different days.
        key = f"{user_id}@{tz.key}:{now_local.date()}"
        if key not in cache:
            try:
                cache[key] = _compose(*await _due_soon(user_id, now_local, tz))
            except db.DbError as e:
                report.errors.append(f"{user_id}: could not read tasks: {e}")
                cache[key] = None

        message = cache[key]
        if message is None:
            report.skipped_nothing_due += 1
            continue

        await _deliver(sub, message, report)

    return report


async def _deliver(sub: dict, message: dict, report: Report) -> None:
    """Send to one device and record what happened against its row.

    Every failure is caught and attributed. One dead subscription must not end
    the run — the whole point of a fleet job is that the other nineteen people
    still get their morning.
    """
    try:
        gone = await push.send(
            endpoint=sub["endpoint"],
            p256dh=sub["p256dh"],
            auth=sub["auth"],
            payload=json.dumps(message).encode("utf-8"),
        )
    except push.PushError as e:
        report.errors.append(f"{sub['endpoint'][:40]}...: {e}")
        try:
            await db.update(
                "push_subscriptions", {"last_error": str(e)[:500]}, id=db.eq(sub["id"])
            )
        except db.DbError:
            pass  # Recording the error must never become the error.
        return

    if gone is not None:
        # Expired, uninstalled, or cleared. Deleting is the documented
        # response — keeping it means pushing to a dead endpoint every morning
        # until the account is deleted.
        report.expired += 1
        try:
            await db.delete("push_subscriptions", id=db.eq(sub["id"]))
        except db.DbError as e:
            report.errors.append(f"could not delete expired subscription: {e}")
        return

    report.sent += 1
    try:
        await db.update(
            "push_subscriptions",
            {"last_sent_at": datetime.now(UTC).isoformat(), "last_error": None},
            id=db.eq(sub["id"]),
        )
    except db.DbError:
        pass

"""Pulling Classroom into the database.

The one rule this file exists to enforce:

    Classroom owns the title and the due date on tasks it created.
    You own status, description, checklists, and any manual override.
    A row with source = 'manual' and no Classroom id is never touched.

Everything else here is bookkeeping around that. It is written as one pass so
there is a single place to read when a task shows up wrong — phase 04's cron
calls exactly this function, with no second implementation to keep in step.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.core import supabase as db
from app.core.config import get_settings
from app.core.crypto import TokenCryptoError, decrypt
from app.services import ai, google

# Kept in step with CLASS_COLORS in frontend/src/lib/types.ts. A colour picked
# from the course id rather than a counter, so re-running import on a fresh
# database gives a class the same colour it had before.
COLORS = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"]


@dataclass
class SyncReport:
    courses_seen: int = 0
    classes_created: int = 0
    classes_linked: int = 0
    tasks_created: int = 0
    tasks_updated: int = 0
    tasks_adopted: int = 0
    tasks_skipped_submitted: int = 0
    tasks_auto_completed: int = 0
    tasks_auto_reopened: int = 0
    courses_skipped_dismissed: int = 0
    courses_skipped_term: int = 0
    # Phase 09. Links are written outright; proposals only ever wait to be read.
    links_created: int = 0
    announcements_read: int = 0
    proposals_created: int = 0
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def _norm(s: str | None) -> str:
    return (s or "").strip().casefold()


def _color_for(course_id: str) -> str:
    return COLORS[sum(course_id.encode()) % len(COLORS)]


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def _day(value: str | None) -> str | None:
    """The calendar day of a stored timestamp, for loose manual-task matching.

    Matching a hand-typed task to its Classroom original on the exact minute
    would never fire — nobody types 23:59. The day is the part a student
    actually knows.
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


async def get_access_grant(user_id: str) -> google.AccessToken:
    """The stored refresh token, spent for a live access token and its scopes.

    Raises ReconnectRequired for every case the user can fix by pressing
    Connect again — expired grant, revoked access, or a key rotation that
    orphaned the ciphertext. The caller turns that into the banner.
    """
    rows = await db.select("google_tokens", user_id=db.eq(user_id))
    if not rows:
        raise google.ReconnectRequired("Classroom is not connected")

    try:
        refresh_token = decrypt(rows[0]["refresh_token_enc"])
    except TokenCryptoError as exc:
        raise google.ReconnectRequired(str(exc)) from exc

    try:
        access = await google.exchange_refresh_token(refresh_token)
    except google.ReconnectRequired:
        await db.update(
            "google_tokens", {"needs_reconnect": True}, user_id=db.eq(user_id)
        )
        raise

    await db.update(
        "google_tokens",
        {
            "needs_reconnect": False,
            "last_refreshed_at": _iso(datetime.now(timezone.utc)),
        },
        user_id=db.eq(user_id),
    )
    return access


async def get_access_token(user_id: str) -> str:
    """The token alone, for the callers that do not care what it can do.

    A thin wrapper rather than a second implementation: the decrypt, the
    exchange, and the needs_reconnect bookkeeping happen in exactly one place,
    and the calendar route gets the scopes it has to check before it can tell
    a missing permission from a broken one.
    """
    return (await get_access_grant(user_id)).token


async def _sync_classes(
    user_id: str,
    courses: list[dict],
    dismissed: set[str],
    terms: list[str],
    report: SyncReport,
) -> dict[str, dict]:
    """Course id -> the class row that represents it."""
    existing = await db.select("classes", user_id=db.eq(user_id))
    by_course = {c["google_course_id"]: c for c in existing if c["google_course_id"]}
    # Only unlinked classes are candidates for adoption. A class already
    # pointing at another course must never be stolen by a name collision.
    by_name = {_norm(c["name"]): c for c in existing if not c["google_course_id"]}

    mapping: dict[str, dict] = {}

    for course in courses:
        course_id = course["id"]
        name = course.get("name") or "Untitled course"

        # Dismissal wins over everything. The user deleted this course, and
        # re-importing what someone just deleted is the worst thing a sync can
        # do — it looks like the app ignoring them.
        if course_id in dismissed:
            report.courses_skipped_dismissed += 1
            continue

        if course_id in by_course:
            # Already imported, so the term filter does not get a second vote.
            # Narrowing the filter must not abandon a course mid-semester.
            mapping[course_id] = by_course[course_id]
            continue

        if terms and not any(t in _norm(name) for t in terms):
            report.courses_skipped_term += 1
            continue

        match = by_name.pop(_norm(name), None)
        if match:
            # The link is an attachment, never an identity. The class keeps
            # its own name, colour and professor — the user chose those, and
            # a course code is rarely what they wanted to call it.
            rows = await db.update(
                "classes",
                {"google_course_id": course_id},
                id=db.eq(match["id"]),
                user_id=db.eq(user_id),
            )
            mapping[course_id] = rows[0] if rows else {**match, "google_course_id": course_id}
            report.classes_linked += 1
            continue

        try:
            rows = await db.insert(
                "classes",
                {
                    "user_id": user_id,
                    "name": name,
                    "color": _color_for(course_id),
                    "meeting_info": course.get("section"),
                    "google_course_id": course_id,
                },
            )
            report.classes_created += 1
        except db.DuplicateKey:
            # Another sync created this class between our select and our
            # insert. Phase 04's cron will overlap a manual refresh eventually,
            # so this is a normal outcome, not a failure: adopt their row.
            rows = await db.select(
                "classes",
                user_id=db.eq(user_id),
                google_course_id=db.eq(course_id),
            )
            if not rows:
                raise

        # Recorded so a course repeated within one listing cannot insert twice.
        by_course[course_id] = rows[0]
        mapping[course_id] = rows[0]

    return mapping


def _submission_patch(
    task: dict, state: str | None, report: SyncReport
) -> dict:
    """Status, decided by what Classroom says you handed in.

    This is the only place sync writes a task's status, and it defers in two
    directions:

    * `status_overridden` is absolute. You moved this card away from where a
      sync put it, so sync has lost the argument permanently and does not
      reopen it.
    * A card you dragged to Done yourself is left alone too — `auto_completed`
      is false on it, and demoting somebody's own tick because Classroom has
      no record of a submission would be the app calling them a liar. Plenty
      of work is submitted on paper, over email, or in person.

    So the only card sync will un-complete is one it completed itself, and
    only when the submission genuinely went away — an unsubmit before the
    deadline, which is a real thing students do and which should put the work
    back on the board.
    """
    if task["status_overridden"]:
        return {}

    submitted = state in google.SUBMITTED_STATES

    if submitted and task["status"] != "done":
        report.tasks_auto_completed += 1
        return {"status": "done", "auto_completed": True}

    if not submitted and task["status"] == "done" and task["auto_completed"]:
        report.tasks_auto_reopened += 1
        # archived_at and completed_at are cleared by the database trigger on
        # the way out of 'done', so a task that had already aged off the board
        # comes back with it rather than staying invisibly archived.
        return {"status": "todo", "auto_completed": False}

    return {}


async def _sync_coursework(
    user_id: str,
    token: str,
    mapping: dict[str, dict],
    harvest: dict[str, list[dict]],
    report: SyncReport,
) -> None:
    # Archived rows are included on purpose: a task finished and archived
    # last month must not be recreated as fresh work on the next sync.
    tasks = await db.select("tasks", user_id=db.eq(user_id))
    by_coursework = {
        t["google_coursework_id"]: t for t in tasks if t["google_coursework_id"]
    }
    manual_index = {
        (_norm(t["title"]), _day(t["due_at"])): t
        for t in tasks
        if t["source"] == "manual" and not t["google_coursework_id"]
    }

    for course_id, klass in mapping.items():
        # Vestigial since removing a class replaced hiding one, but the column
        # still exists and honouring it costs a dict lookup.
        if klass.get("hidden"):
            continue

        try:
            coursework = await google.list_coursework(token, course_id)
            submissions = await google.list_submissions(token, course_id)
        except google.ClassroomError as exc:
            # One inaccessible course must not sink the whole sync.
            report.warnings.append(f"{klass['name']}: {exc}")
            continue

        # Kept for phase 09's attachment ingest, which runs after this pass.
        # These posts carry a `materials[]` array as well as a due date, and
        # re-listing them later would be a second identical request to Google
        # for something already in hand.
        harvest[course_id] = coursework

        for cw in coursework:
            due = google.due_at(cw)
            if due is None:
                continue  # Not a deadline, and this app is deadlines first.

            cw_id = cw["id"]
            title = cw.get("title") or "Untitled assignment"
            due_day = due.date().isoformat()

            existing = by_coursework.get(cw_id)
            if existing:
                # The conflict rule, in the only place it is applied.
                patch: dict = {}
                if existing["title"] != title:
                    patch["title"] = title
                if _day(existing["due_at"]) != due_day:
                    patch["due_at"] = _iso(due)
                if existing["class_id"] is None:
                    patch["class_id"] = klass["id"]

                patch.update(
                    _submission_patch(existing, submissions.get(cw_id), report)
                )

                if patch:
                    await db.update(
                        "tasks", patch, id=db.eq(existing["id"]), user_id=db.eq(user_id)
                    )
                    report.tasks_updated += 1
                continue

            adopted = manual_index.pop((_norm(title), due_day), None)
            if adopted:
                # Typed by hand before the sync existed. Attaching the ids
                # rather than inserting a duplicate keeps whatever notes and
                # checklists were already hung off it.
                await db.update(
                    "tasks",
                    {
                        "google_coursework_id": cw_id,
                        "google_course_id": course_id,
                        "source": "classroom",
                        "class_id": adopted["class_id"] or klass["id"],
                    },
                    id=db.eq(adopted["id"]),
                    user_id=db.eq(user_id),
                )
                report.tasks_adopted += 1
                continue

            if submissions.get(cw_id) in google.SUBMITTED_STATES:
                # No backfill of work already handed in. First connect should
                # show what is left to do, not a wall of finished homework.
                report.tasks_skipped_submitted += 1
                continue

            try:
                await db.insert(
                    "tasks",
                    {
                        "user_id": user_id,
                        "class_id": klass["id"],
                        "title": title,
                        "description": cw.get("description"),
                        "due_at": _iso(due),
                        "status": "todo",
                        "source": "classroom",
                        "google_coursework_id": cw_id,
                        "google_course_id": course_id,
                    },
                )
                report.tasks_created += 1
            except db.DuplicateKey:
                # A concurrent sync already imported this assignment. Theirs
                # is identical to what we were about to write.
                pass


# ---------------------------------------------------------------------------
# Phase 09 — attachments, which are facts, and deadlines, which are guesses
# ---------------------------------------------------------------------------

# How far back a first sync is willing to send prose to a model.
#
# `announcements_seen` guarantees an announcement is read once ever, but the
# first run on a course three months into term would otherwise read the whole
# term in one go — dozens of calls, to find deadlines that have already passed.
# Older announcements are marked seen without being read, because a deadline
# from six weeks ago is not work, it is history.
AI_HORIZON_DAYS = 14


async def _ingest_attachments(
    user_id: str,
    class_id: str,
    posts: list[dict],
    existing: dict[str, dict],
    next_position: int,
    report: SyncReport,
) -> int:
    """Drive files and links from Classroom posts, written straight to Docs.

    The one place in this app where something arrives from Google and is *not*
    proposed for approval. Nothing inferred it: `materials[]` is a structured
    array Classroom maintains, and a link is a fact. Putting a fact in a review
    queue would train the habit of pressing Accept without reading, which is
    precisely what would make the deadline queue next door worthless.

    Deduped on the id Google gave it, so the hourly cron sees the same syllabus
    forever and writes it once. Nothing here ever updates a row it did not
    create: a title the user renamed on their own Docs tab stays renamed.

    Returns the next free position, so a course's posts append in order rather
    than all claiming the same slot.
    """
    for post in posts:
        for att in google.attachments_of(post):
            if att.key in existing:
                continue
            try:
                rows = await db.insert(
                    "class_links",
                    {
                        "user_id": user_id,
                        "class_id": class_id,
                        "title": att.title[:200],
                        "url": att.url[:2000],
                        "position": next_position,
                        "google_material_id": att.key,
                        "google_drive_id": att.drive_id,
                    },
                )
            except db.DuplicateKey:
                # A concurrent sync got there first. Theirs is identical.
                existing[att.key] = {}
                continue
            existing[att.key] = rows[0] if rows else {}
            next_position += 1
            report.links_created += 1
    return next_position


async def _read_announcements(
    user_id: str,
    course_id: str,
    klass: dict,
    posts: list[dict],
    report: SyncReport,
) -> None:
    """The prose, read once ever, for a deadline it might be hiding.

    This is the only place in `sync_user` a model is involved, and what it can
    do is bounded to one thing: write a row in `proposals`. It cannot create a
    task, move a due date or touch anything already on the board. One
    hallucinated deadline that wrote itself onto a Tuesday would end trust in
    every other date the app shows, and there are several hundred of those.

    An announcement is marked seen whether or not it produced anything, and
    that is the whole cost control: "no deadline here" is a permanent answer.
    A failed call is deliberately *not* marked, so the next hourly pass retries
    it for free rather than losing it.
    """
    rows = await db.select("announcements_seen", user_id=db.eq(user_id))
    seen = {r["announcement_id"] for r in rows}

    cutoff = datetime.now(timezone.utc) - timedelta(days=AI_HORIZON_DAYS)

    for post in posts:
        ann_id = post.get("id")
        if not ann_id or ann_id in seen:
            continue

        text = (post.get("text") or "").strip()
        posted = google.posted_at(post)

        # Marked seen without being read: too old to matter, or nothing to
        # read. Both are permanent facts about this announcement.
        if not text or posted is None or posted < cutoff:
            await _mark_seen(user_id, course_id, ann_id)
            continue

        try:
            found = await ai.propose_deadline(
                course_name=klass["name"],
                posted_on=posted.date(),
                text=text,
            )
        except ai.AiUnavailable:
            # The flag went off mid-run. Not this announcement's problem, and
            # not something to record as read.
            return
        except ai.AiError as exc:
            # One announcement's failure, counted and dropped. The sync's job
            # is deadlines from coursework; this is the part that can be
            # missing without the run being wrong.
            report.warnings.append(f"{klass['name']} announcement: {exc}")
            continue

        report.announcements_read += 1

        if found is not None:
            try:
                await db.insert(
                    "proposals",
                    {
                        "user_id": user_id,
                        "class_id": klass["id"],
                        "kind": "deadline",
                        "source_kind": "announcement",
                        "source_id": ann_id,
                        "payload": {
                            "title": found.title,
                            "due_date": found.due_at,
                            "excerpt": found.excerpt,
                            # Kept so the queue can offer "open the original"
                            # — a proposal you cannot check at the source is
                            # one you can only take on faith.
                            "announcement_url": post.get("alternateLink"),
                            "class_name": klass["name"],
                        },
                    },
                )
                report.proposals_created += 1
            except db.DuplicateKey:
                # Already asked, and answered — including answered "no". A
                # rejected proposal is kept precisely so this insert fails.
                pass

        await _mark_seen(user_id, course_id, ann_id)


async def _mark_seen(user_id: str, course_id: str, announcement_id: str) -> None:
    try:
        await db.insert(
            "announcements_seen",
            {
                "user_id": user_id,
                "google_course_id": course_id,
                "announcement_id": announcement_id,
            },
        )
    except db.DuplicateKey:
        pass


async def _sync_extras(
    user_id: str,
    grant: google.AccessToken,
    mapping: dict[str, dict],
    harvest: dict[str, list[dict]],
    report: SyncReport,
) -> None:
    """Materials and announcements, for every course, after coursework.

    Deliberately last. Coursework is what the app exists for, and a Drive
    outage or a rate-limited model must never be the reason a due date failed
    to arrive — by the time this runs, every deadline Classroom stated
    outright is already on the board.

    Each permission is checked separately and skipped quietly when absent.
    Everyone connected before phase 09 is in exactly that position: their
    grant predates these scopes, the reconnect banner is asking them about it,
    and until they answer, the rest of the sync must work exactly as before.
    """
    materials_ok = google.MATERIALS_SCOPE in grant.scopes
    announcements_ok = google.ANNOUNCEMENTS_SCOPE in grant.scopes
    ai_ok = announcements_ok and ai.enabled()

    for course_id, klass in mapping.items():
        links = await db.select(
            "class_links", user_id=db.eq(user_id), class_id=db.eq(klass["id"])
        )
        existing = {l["google_material_id"]: l for l in links if l.get("google_material_id")}
        position = max((l.get("position") or 0) for l in links) + 1 if links else 0

        # Attachments on coursework need no new permission at all — the pass
        # above already read those posts, and `harvest` is that read, not a
        # second one. So the syllabus a professor stapled to an assignment
        # reaches the Docs tab even for a grant that predates phase 09.
        position = await _ingest_attachments(
            user_id, klass["id"], harvest.get(course_id, []), existing, position, report
        )

        if materials_ok:
            try:
                posts = await google.list_coursework_materials(grant.token, course_id)
            except google.ClassroomError as exc:
                report.warnings.append(f"{klass['name']} materials: {exc}")
            else:
                position = await _ingest_attachments(
                    user_id, klass["id"], posts, existing, position, report
                )

        if not announcements_ok:
            continue

        try:
            posts = await google.list_announcements(grant.token, course_id)
        except google.ClassroomError as exc:
            report.warnings.append(f"{klass['name']} announcements: {exc}")
            continue

        position = await _ingest_attachments(
            user_id, klass["id"], posts, existing, position, report
        )

        if ai_ok:
            await _read_announcements(user_id, course_id, klass, posts, report)


async def sync_user(user_id: str) -> SyncReport:
    """One full pass. Phase 04's cron calls this and nothing else."""
    report = SyncReport()
    started = _iso(datetime.now(timezone.utc))

    try:
        grant = await get_access_grant(user_id)
        token = grant.token
        courses = await google.list_courses(token)
        report.courses_seen = len(courses)

        rows = await db.select("dismissed_courses", user_id=db.eq(user_id))
        dismissed = {r["google_course_id"] for r in rows}
        terms = get_settings().term_filters

        mapping = await _sync_classes(user_id, courses, dismissed, terms, report)
        harvest: dict[str, list[dict]] = {}
        await _sync_coursework(user_id, token, mapping, harvest, report)
        await _sync_extras(user_id, grant, mapping, harvest, report)
    except Exception as exc:
        await _record(user_id, started, report, error=str(exc))
        raise

    await _record(user_id, started, report, error=None)
    return report


async def _record(
    user_id: str, started: str | None, report: SyncReport, error: str | None
) -> None:
    row = {
        "user_id": user_id,
        "last_sync_at": started,
        "last_error": error,
        "courses_synced": report.courses_seen,
        "tasks_synced": report.tasks_created
        + report.tasks_updated
        + report.tasks_adopted,
    }
    if error is None:
        row["last_success_at"] = started
    await db.upsert_on("sync_state", row, conflict="user_id")


@dataclass
class FleetReport:
    """What one cron run did, across every connected user."""

    users_considered: int = 0
    users_synced: int = 0
    users_needing_reconnect: int = 0
    users_failed: int = 0
    tasks_touched: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


async def sync_all() -> FleetReport:
    """Every connected user, one after another. The hourly cron's entry point.

    Sequential rather than concurrent. Under a hundred users on a free dyno
    with a single Google client, the thing worth optimising is not wall-clock
    time — it is never being the reason Google starts rate-limiting the
    project, and never having several syncs of the *same* user in flight.

    Users already flagged `needs_reconnect` are skipped. Their token is known
    dead, and hammering Google with it hourly for the six days until they next
    open the app earns nothing but failed requests. The reconnect banner is
    raised in the browser, so the fix arrives with the user, not with the cron.

    One user's failure never ends the run. A friend who revoked access or a
    course that 403s must not stop everyone else's deadlines from arriving —
    so each is caught, counted, and reported.
    """
    fleet = FleetReport()

    rows = await db.select("google_tokens", needs_reconnect=db.eq("false"))
    fleet.users_considered = len(rows)

    for row in rows:
        user_id = row["user_id"]
        try:
            report = await sync_user(user_id)
        except google.ReconnectRequired:
            # get_access_token already set needs_reconnect, so this user drops
            # out of the query above until they reconnect. Expected weekly in
            # Testing mode; not an error.
            fleet.users_needing_reconnect += 1
            continue
        except Exception as exc:  # noqa: BLE001 — one user must not sink the run
            fleet.users_failed += 1
            # The user id, not the email: this output goes to a GitHub Actions
            # log, and a run log is not a place to accumulate a roster of who
            # uses the app.
            fleet.errors.append(f"{user_id}: {type(exc).__name__}: {exc}")
            continue

        fleet.users_synced += 1
        fleet.tasks_touched += (
            report.tasks_created
            + report.tasks_updated
            + report.tasks_adopted
        )

    return fleet

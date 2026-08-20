"""Summarising one document, and nothing else.

The whole of the AI surface a browser can reach in phase 09 is this one route.
The other model call in the app runs inside `sync_user`, where no one is
waiting on it — deliberately, because Render sleeps and a cold start in front
of an hourly background job costs nothing while a cold start in front of a
button costs thirty seconds of someone staring at a spinner.

What this route will *not* do is fetch a URL. Phase 06 wrote that a link is a
string the user typed and that rendering it as anything more would make this
server an outbound fetcher of whatever anyone pasted; that still holds. A
summary is offered only for a Drive file Classroom itself told us about, read
through the user's own grant. Paste a link to a random site and the answer is
the same plain sentence as for a PDF: not something we can read.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core import supabase as db
from app.core.auth import CurrentUser, get_current_user
from app.services import ai, classroom_sync, google

router = APIRouter(prefix="/ai")

RECONNECT = status.HTTP_409_CONFLICT


class SummariseRequest(BaseModel):
    link_id: str


class SummaryResponse(BaseModel):
    """A summary, or a plain reason there is not one.

    Two nullable fields rather than an error status, because "this is a PDF"
    is not a failure and rendering it in red next to a broken-looking row
    would say the app is wrong when the app is fine. Exactly one is set.
    """

    summary: str | None = None
    reason: str | None = None
    generated_at: str | None = None


@router.post("/summarise-link", response_model=SummaryResponse)
async def summarise_link(
    body: SummariseRequest,
    user: CurrentUser = Depends(get_current_user),
) -> SummaryResponse:
    if not ai.enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI is turned off on this deployment",
        )

    # Service role, so the user_id filter is this function's job and not the
    # database's. Both halves are in the same query for that reason.
    rows = await db.select(
        "class_links", id=db.eq(body.link_id), user_id=db.eq(user.id)
    )
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such link")
    link = rows[0]

    # Cached. A document is paid for once, and pressing the button again on a
    # row that already has a summary is free — which is what makes it safe to
    # leave the button visible rather than hiding it after one press.
    if link.get("summary"):
        return SummaryResponse(
            summary=link["summary"], generated_at=link.get("summary_generated_at")
        )

    file_id = link.get("google_drive_id")
    if not file_id:
        return SummaryResponse(
            reason="This is a link, not a document — there is nothing to read."
        )

    try:
        grant = await classroom_sync.get_access_grant(user.id)
    except google.ReconnectRequired as exc:
        raise HTTPException(status_code=RECONNECT, detail=str(exc)) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    # Checked before the call rather than after a 403, for the same reason the
    # calendar route checks: a permission never granted and a Google outage
    # produce the same body, and only one of them is the user's to fix.
    if google.DRIVE_SCOPE not in grant.scopes:
        return SummaryResponse(
            reason=(
                "Reading documents needs one more Google permission. "
                "Reconnect Classroom to allow it."
            )
        )

    try:
        title, text = await google.export_text(
            grant.token, file_id, limit=ai.MAX_DOC_CHARS
        )
    except google.UnreadableFile:
        return SummaryResponse(reason="Can’t read this file type.")
    except google.ReconnectRequired as exc:
        raise HTTPException(status_code=RECONNECT, detail=str(exc)) from exc
    except google.ClassroomError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    try:
        summary = await ai.summarise_document(title=title or link["title"], text=text)
    except ai.AiUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except ai.AiError as exc:
        # A real failure, and said as one: the file was readable, we asked, and
        # the answer did not come. Retrying is worth offering here.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    generated_at = datetime.now(timezone.utc).isoformat()
    await db.update(
        "class_links",
        {"summary": summary, "summary_generated_at": generated_at},
        id=db.eq(link["id"]),
        user_id=db.eq(user.id),
    )

    return SummaryResponse(summary=summary, generated_at=generated_at)


# ---------------------------------------------------------------------------
# Reading an uploaded document — phase 10
# ---------------------------------------------------------------------------
#
# One route for two schemas, because the pipeline either side of the model is
# identical: the browser has already uploaded the file to `class-docs` under
# its own RLS and written the `class_documents` row, and all that is left is
# to read the bytes and ask.
#
# This route writes nothing. It returns rows, the browser puts them in an
# editable table, and Confirm — which is a plain Supabase insert from the
# browser, RLS-protected like every other write in this app — is what makes
# them real. That is PLAN.md's rule with the review step moved on screen: a
# `proposals` row would outlive the moment in which the person is still
# holding the handout, which is the only moment they can check it in.


class ExtractRequest(BaseModel):
    document_id: str


class ExtractedSession(BaseModel):
    date: str
    topic: str
    details: str = ""
    is_assessment: bool = False


class ExtractedCriterion(BaseModel):
    label: str
    weight: float
    max_score: float


class ExtractResponse(BaseModel):
    """What the document seems to say, and nothing written down.

    `kind` is echoed back so the review table knows which of the two lists to
    render without having to remember what it asked for — the upload may well
    have finished in a tab that has since been reloaded.

    Both lists can be empty, and an empty list is not an error: a photograph
    of the wrong page is an ordinary mistake, and it earns the sentence in
    `note` rather than a red box.
    """

    kind: str
    title: str = ""
    sessions: list[ExtractedSession] = []
    criteria: list[ExtractedCriterion] = []
    note: str | None = None


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    body: ExtractRequest,
    user: CurrentUser = Depends(get_current_user),
) -> ExtractResponse:
    if not ai.enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI is turned off on this deployment",
        )

    # Service role bypasses RLS, so the user_id filter is this function's job.
    # It is also what makes the storage read below safe: the path is taken off
    # a row this query proved belongs to the caller, never off the request.
    rows = await db.select(
        "class_documents", id=db.eq(body.document_id), user_id=db.eq(user.id)
    )
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such document")
    doc = rows[0]

    classes = await db.select("classes", id=db.eq(doc["class_id"]), user_id=db.eq(user.id))
    course_name = classes[0]["name"] if classes else ""

    try:
        data = await db.download_object("class-docs", doc["storage_path"])
    except db.DbError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "That file could not be read back"
        ) from exc

    mime = doc.get("mime_type") or ""

    try:
        if doc["kind"] == "timetable":
            sessions = await ai.extract_timetable(
                course_name=course_name,
                today=datetime.now(timezone.utc).date(),
                data=data,
                mime_type=mime,
            )
            return ExtractResponse(
                kind="timetable",
                sessions=[
                    ExtractedSession(
                        date=s.on_date,
                        topic=s.topic,
                        details=s.details,
                        is_assessment=s.is_assessment,
                    )
                    for s in sessions
                ],
                note=(
                    None
                    if sessions
                    else "No dated rows were found in this document."
                ),
            )

        title, criteria = await ai.extract_rubric(
            course_name=course_name, data=data, mime_type=mime
        )
        return ExtractResponse(
            kind="rubric",
            title=title,
            criteria=[
                ExtractedCriterion(
                    label=c.label, weight=c.weight, max_score=c.max_score
                )
                for c in criteria
            ],
            note=None if criteria else "No graded components were found in this document.",
        )
    except ai.AiUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except ai.AiError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


# ---------------------------------------------------------------------------
# Arguing with the planner — phase 13
# ---------------------------------------------------------------------------
#
# One route, one turn, nothing stored. It reads the week out of the database
# under the caller's own id, sends it with the conversation, and returns a
# message and a list of proposed edits. It writes nothing at all — not the
# edits, not the conversation, not a proposals row.
#
# The edits are applied by the browser, on Accept, through the same
# RLS-protected Supabase writes every other change in this app goes through,
# and then `planWeek` runs there and produces the blocks. That is the phase 13
# rule in one sentence: the model changes the inputs, the ordinary planner
# makes the output.
#
# The week is assembled here rather than accepted from the request, because a
# request that carried its own task list would be a request that could carry
# somebody else's. The only thing taken on trust is the horizon, which is a
# fact about the tab's timezone that this server has no way to know, and the
# rail, whose ids are checked against the tasks this query returned.

# What a person can type in one go. Long enough for a paragraph about a bad
# week; short enough that it cannot become a document.
MAX_MESSAGE_CHARS = 1000
MAX_HISTORY = 24


class PlanTurn(BaseModel):
    """One line of the conversation. `role` is "user" or "model"."""

    role: str
    text: str


class UnplacedItem(BaseModel):
    task_id: str
    minutes: int


class PlanRequest(BaseModel):
    turns: list[PlanTurn]
    #: The horizon, in the browser's own timezone and with its offset attached.
    from_at: str
    to_at: str
    unplaced: list[UnplacedItem] = []


class PlanEditOut(BaseModel):
    kind: str
    why: str
    task_id: str | None = None
    minutes: int | None = None
    starts_at: str | None = None
    ends_at: str | None = None
    reason: str | None = None
    until: str | None = None
    keep_minutes: int | None = None
    rest_title: str | None = None
    rest_minutes: int | None = None


class PlanResponse(BaseModel):
    """What was said, and what it would change. Nothing has changed yet.

    Two fields and no id, because there is nothing to refer back to: reject it
    and there is no row to mark rejected, reload the tab and the whole
    exchange is gone. That is deliberate — see PLAN.md, phase 13.
    """

    message: str
    edits: list[PlanEditOut] = []


@router.post("/plan", response_model=PlanResponse)
async def plan(
    body: PlanRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PlanResponse:
    if not ai.enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI is turned off on this deployment",
        )

    turns = [
        (t.role, t.text.strip()[:MAX_MESSAGE_CHARS])
        for t in body.turns[-MAX_HISTORY:]
        if t.text.strip()
    ]
    if not turns or turns[-1][0] != "user":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "There is nothing there to answer"
        )

    try:
        begins = ai.horizon_start(body.from_at)
        ends = ai.horizon_start(body.to_at)
    except (ValueError, ai.AiError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "That is not a week I can read"
        ) from exc
    if ends <= begins:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That week runs backwards")

    # Service role bypasses RLS, so every read below carries the user filter
    # itself. This is also the only list of task ids the model will be allowed
    # to name — see `_clean_edits`.
    tasks = await db.select("tasks", user_id=db.eq(user.id), status="neq.done")
    classes = await db.select("classes", user_id=db.eq(user.id))
    routines = await db.select("routines", user_id=db.eq(user.id), active="is.true")
    blackouts = await db.select("blackouts", user_id=db.eq(user.id))
    blocks = await db.select("plan_blocks", user_id=db.eq(user.id))

    class_names = {c["id"]: c.get("name") or "" for c in classes}

    # Minutes already set aside, per task, inside the horizon. The model needs
    # this to tell "unestimated" from "estimated and already handled".
    planned: dict[str, int] = {}
    for b in blocks:
        task_id = b.get("task_id")
        if not task_id:
            continue
        try:
            start = datetime.fromisoformat(b["starts_at"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(b["ends_at"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if end <= begins or start >= ends:
            continue
        planned[task_id] = planned.get(task_id, 0) + int(
            (end - start).total_seconds() // 60
        )

    live = [t for t in tasks if not t.get("archived_at")]
    week_tasks = [
        ai.PlanTask(
            id=t["id"],
            title=t.get("title") or "",
            class_name=class_names.get(t.get("class_id"), ""),
            due_on=(t.get("due_at") or "")[:10] or None,
            estimate_minutes=t.get("estimate_minutes"),
            planned_minutes=planned.get(t["id"], 0),
            deferred_until=t.get("plan_skip_until"),
        )
        for t in live
    ]

    owned = {t["id"] for t in live}
    titles = {t["id"]: (t.get("title") or "") for t in live}

    return await _answer(
        tasks=week_tasks,
        routines=[
            f"{r.get('title') or 'Routine'} — "
            f"{'every day' if r.get('weekday') is None else _WEEKDAYS[int(r['weekday'])]}"
            f" at {str(r.get('time_of_day') or '')[:5]} for "
            f"{r.get('duration_minutes')} minutes"
            for r in routines
        ],
        blackouts=[
            f"{b['starts_at']} to {b['ends_at']}"
            + (f" ({b['reason']})" if b.get("reason") else "")
            for b in blackouts
            if b.get("starts_at") and b.get("ends_at")
        ],
        unplaced=[
            f"{titles[u.task_id]} — {u.minutes} minutes with no hour against it"
            for u in body.unplaced
            if u.task_id in owned
        ],
        horizon=(body.from_at, body.to_at),
        turns=turns,
    )


_WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
]


async def _answer(**kwargs: object) -> PlanResponse:
    """The call and its three failure modes, kept away from the assembly above.

    A model that is off, a model that did not answer, and a model that
    answered: three outcomes, and only the last of them is a plan. None of
    them writes anything.
    """
    try:
        advice = await ai.plan_advice(**kwargs)  # type: ignore[arg-type]
    except ai.AiUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except ai.AiError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return PlanResponse(
        message=advice.message,
        edits=[
            PlanEditOut(
                kind=e.kind,
                why=e.why,
                task_id=e.task_id,
                minutes=e.minutes,
                starts_at=e.starts_at,
                ends_at=e.ends_at,
                reason=e.reason,
                until=e.until,
                keep_minutes=e.keep_minutes,
                rest_title=e.rest_title,
                rest_minutes=e.rest_minutes,
            )
            for e in advice.edits
        ],
    )

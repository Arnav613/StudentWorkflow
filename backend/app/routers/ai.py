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

"""The one place in this application that calls a model.

Phase 09's rule, and the reason this file is a service rather than a helper
imported wherever it is handy: every prompt, every schema, every timeout and
every input bound lives here. There is one Gemini client, the way there is one
`sync_user` and one `moveTask`, so "what did we send Google?" has one answer.

Three constraints apply to every call below without exception.

**A JSON schema.** `responseSchema` makes Gemini's output a parse, not an
interpretation. Nothing here reads prose looking for a date; if the model
cannot fill the schema it returns the empty case and that is a clean no.

**A hard timeout.** Sync runs inside an hourly cron on a free dyno. A model
that hangs must cost one announcement, not the run.

**A bounded input.** An unbounded prompt is an unbounded bill. Every caller
truncates before it gets here, and this file truncates again — the second
check is not redundant, it is the one that survives a new caller.

Deliberately absent: any retry. A transient failure means the announcement is
not marked seen and the next hourly pass tries again for free, which is a
better retry than one that hammers a rate limit inside the same request.
"""

import json
from dataclasses import dataclass
from datetime import date

import httpx

from app.core.config import get_settings

API = "https://generativelanguage.googleapis.com/v1beta"

# Long enough for a wordy professor, short enough that a pasted syllabus does
# not become a bill. Announcements that exceed it are cut, not skipped: the
# date is nearly always in the first paragraph.
MAX_PROSE_CHARS = 4000

# A document is bigger than an announcement and this is a summary, so it gets
# more room — but still a ceiling, and still a cut rather than a refusal.
MAX_DOC_CHARS = 20000

TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class AiUnavailable(RuntimeError):
    """No key, or the flag is off. A feature that is not on, not a failure."""


class AiError(RuntimeError):
    """The model was called and did not answer usefully."""


@dataclass(frozen=True)
class DeadlineProposal:
    """A guess, with the sentence that produced it.

    `excerpt` is not decoration. The review queue shows it beside the proposed
    date, and a proposal a person cannot check against the professor's own
    words is one they can only accept on faith — which is the failure mode
    this whole approval step exists to prevent.
    """

    title: str
    due_at: str  # ISO date, YYYY-MM-DD
    excerpt: str


def enabled() -> bool:
    return get_settings().ai_ready


async def _generate(prompt: str, schema: dict, *, system: str) -> dict:
    """One call. Every AI feature in the app goes through this function."""
    settings = get_settings()
    if not settings.ai_ready:
        raise AiUnavailable("AI is turned off on this deployment")

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema,
            # Zero. This is extraction, not writing: the same announcement
            # read twice should give the same date both times.
            "temperature": 0.0,
        },
    }

    try:
        async with httpx.AsyncClient(base_url=API, timeout=TIMEOUT) as http:
            res = await http.post(
                f"/models/{settings.gemini_model}:generateContent",
                params={"key": settings.gemini_api_key},
                json=body,
            )
    except httpx.TimeoutException as exc:
        raise AiError("The model took too long to answer") from exc
    except httpx.HTTPError as exc:
        raise AiError(f"Could not reach the model: {exc}") from exc

    if res.status_code == 429:
        raise AiError("The model is rate limited right now")
    if res.status_code >= 400:
        raise AiError(f"Model refused ({res.status_code}): {res.text[:200]}")

    try:
        parts = res.json()["candidates"][0]["content"]["parts"]
        return json.loads("".join(p.get("text", "") for p in parts))
    except (KeyError, IndexError, ValueError) as exc:
        # A safety block, or a truncated response. Both arrive here looking
        # the same, and both mean the caller has no answer.
        raise AiError("The model returned nothing usable") from exc


# ---------------------------------------------------------------------------
# Deadlines hidden in announcement prose
# ---------------------------------------------------------------------------

_DEADLINE_SYSTEM = """\
You read a single Google Classroom announcement written by a university
professor and decide one thing: does it state a deadline the student must
meet?

Say yes only for a due date the announcement itself states. A lecture time, an
office hour, a room change, a reading suggestion, a reminder of a deadline
with no date in it, and an encouragement to start early are all no.

If the announcement changes a date that already exists ("the essay is now due
Friday"), that is yes — a change is the case that matters most.

Resolve relative dates ("next Friday", "in two weeks") against the date the
announcement was posted, which you are given. If you cannot resolve a date to
a specific calendar day, answer no. A guessed day is worse than no answer.

`title` is what is due, as a student would write it on a to-do list: short, no
date in it, no "reminder" or "announcement". `excerpt` is the professor's own
sentence, quoted exactly and unedited, that states the deadline.
"""

_DEADLINE_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "title": {"type": "string"},
        "due_date": {"type": "string", "description": "YYYY-MM-DD"},
        "excerpt": {"type": "string"},
    },
    "required": ["found"],
}


async def propose_deadline(
    *, course_name: str, posted_on: date, text: str
) -> DeadlineProposal | None:
    """A deadline stated in an announcement, or None — which is the usual answer.

    None covers both "the model found nothing" and "the model found something
    it could not pin to a day". Neither is an error, and the caller marks the
    announcement seen either way: an announcement about a room change will
    never become a deadline no matter how often it is re-read.
    """
    prose = text.strip()[:MAX_PROSE_CHARS]
    if not prose:
        return None

    out = await _generate(
        f"Course: {course_name}\nPosted on: {posted_on.isoformat()}\n\n"
        f"Announcement:\n{prose}",
        _DEADLINE_SCHEMA,
        system=_DEADLINE_SYSTEM,
    )

    if not out.get("found"):
        return None

    due = (out.get("due_date") or "").strip()
    title = (out.get("title") or "").strip()
    try:
        parsed = date.fromisoformat(due)
    except ValueError:
        # The schema asked for a date and got something else. A proposal with
        # an unparseable date is not a weaker proposal, it is not one.
        return None
    if not title:
        return None

    return DeadlineProposal(
        title=title[:200],
        due_at=parsed.isoformat(),
        excerpt=(out.get("excerpt") or "").strip()[:500],
    )


# ---------------------------------------------------------------------------
# Document summaries
# ---------------------------------------------------------------------------

_SUMMARY_SYSTEM = """\
You summarise one course document for a student who has not opened it and
wants to know whether they need to.

Three or four sentences. Say what kind of document it is, what it covers, and
name any dates, weightings or required readings it contains — those are the
things a student is actually looking for.

Do not invent. If the text is too short, garbled, or clearly not a course
document, say so plainly in the summary rather than describing what such a
document usually contains.
"""

_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}


async def summarise_document(*, title: str, text: str) -> str:
    """Three sentences about a document, from its extracted text."""
    body = text.strip()[:MAX_DOC_CHARS]
    if not body:
        raise AiError("There was no readable text in that document")

    out = await _generate(
        f"Document name: {title or '(untitled)'}\n\n{body}",
        _SUMMARY_SCHEMA,
        system=_SUMMARY_SYSTEM,
    )
    summary = (out.get("summary") or "").strip()
    if not summary:
        raise AiError("The model returned an empty summary")
    return summary[:2000]

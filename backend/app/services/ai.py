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

import base64
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

# Longer, and only for the routes that send a file. A scanned twelve-page
# syllabus is a genuinely slower read than an announcement, and someone is
# watching this one happen — a timeout that fires on a document which would
# have arrived costs a re-upload, not a saved second.
FILE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


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

# A runaway guard, not an editorial limit.
#
# "Here is the plan for the rest of term" is an ordinary post and can honestly
# carry five or six dates, all of which are real work the student owes. This
# exists only so a malformed answer or a pathological wall of text cannot turn
# one announcement into forty cards. Anything past it is dropped, and the
# dropped ones are the least prominent — the model is asked to lead with what
# matters.
MAX_DEADLINES = 10

_DEADLINE_SYSTEM = """\
You read a single Google Classroom announcement written by a university
professor and find every deadline it states.

Usually there are none, and that is the expected answer: return an empty list.
Sometimes there is one. Occasionally a post sets out a plan for the rest of
term and states several, and then you must return all of them — a professor
listing three dates in one paragraph is one post and three pieces of work.

Include only a due date the announcement itself states. A lecture time, an
office hour, a room change, a reading suggestion, a reminder of a deadline
with no date in it, and an encouragement to start early are all excluded.

If the announcement changes a date that already exists ("the essay is now due
Friday"), include it — a change is the case that matters most.

Resolve relative dates ("next Friday", "in two weeks") against the date the
announcement was posted, which you are given. If you cannot resolve a date to
a specific calendar day, leave that one out. A guessed day is worse than no
answer.

Do not list the same deadline twice because it is mentioned twice.

Order them by how prominent they are in the announcement, most prominent
first.

For each: `title` is what is due, as a student would write it on a to-do list
— short, no date in it, no "reminder" or "announcement". `excerpt` is the
professor's own sentence, quoted exactly and unedited, that states that
particular deadline.
"""

_DEADLINE_SCHEMA = {
    "type": "object",
    "properties": {
        "deadlines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "due_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "excerpt": {"type": "string"},
                },
                "required": ["title", "due_date"],
            },
        }
    },
    "required": ["deadlines"],
}


async def propose_deadlines(
    *, course_name: str, posted_on: date, text: str
) -> list[DeadlineProposal]:
    """Every deadline an announcement states, which is usually none.

    An empty list covers both "the model found nothing" and "the model found
    something it could not pin to a day". Neither is an error, and the caller
    marks the announcement seen either way: an announcement about a room change
    will never become a deadline no matter how often it is re-read.

    This returns a list rather than one result because a professor setting out
    a term plan states several dates in a single post, and the first version of
    this function could only ever report one of them. The other two were
    dropped in silence, which is the one failure this app is not allowed.
    """
    prose = text.strip()[:MAX_PROSE_CHARS]
    if not prose:
        return []

    out = await _generate(
        f"Course: {course_name}\nPosted on: {posted_on.isoformat()}\n\n"
        f"Announcement:\n{prose}",
        _DEADLINE_SCHEMA,
        system=_DEADLINE_SYSTEM,
    )

    raw = out.get("deadlines")
    if not isinstance(raw, list):
        return []

    found: list[DeadlineProposal] = []
    # Deduped on what the proposal actually is. The prompt asks for no repeats
    # and mostly gets none; this is the check that does not depend on asking.
    seen: set[tuple[str, str]] = set()

    for item in raw:
        if not isinstance(item, dict):
            continue

        title = (item.get("title") or "").strip()
        due = (item.get("due_date") or "").strip()
        if not title:
            continue
        try:
            parsed = date.fromisoformat(due)
        except (TypeError, ValueError):
            # The schema asked for a date and got something else. A proposal
            # with an unparseable date is not a weaker proposal, it is not one.
            continue

        key = (title.casefold(), parsed.isoformat())
        if key in seen:
            continue
        seen.add(key)

        found.append(
            DeadlineProposal(
                title=title[:200],
                due_at=parsed.isoformat(),
                excerpt=(item.get("excerpt") or "").strip()[:500],
            )
        )

        if len(found) == MAX_DEADLINES:
            break

    return found


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


# ---------------------------------------------------------------------------
# Reading a document that is not text — phase 10
# ---------------------------------------------------------------------------
#
# Phase 09 only ever sent Gemini prose: an announcement body, or the text
# Google Docs exported for us. A timetable is neither. It arrives as a PDF the
# professor typed in Word, or as a photograph of a printed handout taken in a
# lecture hall, and there is no export endpoint that turns either into text
# this app could then parse. Gemini reads both natively, which is most of the
# rest of why it won the provider choice in phase 09.
#
# The bytes go inline, base64, in the same request as the prompt. The
# alternative — Google's Files API — buys support for files larger than a
# request body can hold, and costs a second round trip, a file lifetime to
# reason about, and a second place a professor's handout sits on somebody
# else's disk. The `class-docs` bucket caps an upload at 15 MB precisely so
# that the simpler of the two is always sufficient.

# The bucket's own limit is the real gate. This is the check that survives a
# bucket policy someone widens later without reading this file.
MAX_FILE_BYTES = 15 * 1024 * 1024

SUPPORTED_MIME = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
}


async def _generate_from_file(
    *, data: bytes, mime_type: str, prompt: str, schema: dict, system: str
) -> dict:
    """`_generate`, with a document in front of the prompt.

    A near-duplicate of `_generate` and deliberately not merged into it. The
    two differ in the one line that matters — what is in `parts` — and folding
    that into an optional argument would leave the function every model call
    in this app passes through harder to read than the two it replaced.
    """
    settings = get_settings()
    if not settings.ai_ready:
        raise AiUnavailable("AI is turned off on this deployment")

    if mime_type not in SUPPORTED_MIME:
        raise AiError(f"Cannot read a {mime_type or 'file of unknown type'}")
    if not data:
        raise AiError("That file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise AiError("That file is too large to read")

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": base64.b64encode(data).decode("ascii"),
                        }
                    },
                    {"text": prompt},
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "temperature": 0.0,
        },
    }

    try:
        async with httpx.AsyncClient(base_url=API, timeout=FILE_TIMEOUT) as http:
            res = await http.post(
                f"/models/{settings.gemini_model}:generateContent",
                params={"key": settings.gemini_api_key},
                json=body,
            )
    except httpx.TimeoutException as exc:
        raise AiError("The model took too long to read that document") from exc
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
        raise AiError("The model returned nothing usable") from exc


# ---------------------------------------------------------------------------
# Timetables
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionRow:
    """One line of a professor's schedule, as extracted.

    Nothing here is written by this function or by the route that calls it.
    These go on screen in an editable table and a person presses Confirm — a
    timetable is right most of the time and wrong in ways only the person
    holding the handout can see.
    """

    on_date: str  # ISO date, YYYY-MM-DD
    topic: str
    details: str
    is_assessment: bool


# A term of twice-weekly lectures is about thirty rows; a weekly three-hour
# seminar is twelve. Sixty is well past any honest timetable, and exists so
# that a pathological document cannot become a thousand rows in a table
# somebody then has to read.
MAX_SESSIONS = 60

_TIMETABLE_SYSTEM = """\
You read one document a university professor handed out — a course timetable,
a session plan, or the schedule section of a syllabus — and return its rows.

The document may be a clean table, a bulleted list, or a photograph of a
printed handout. Read whatever structure is there.

Return one entry per scheduled meeting or scheduled assessment. `topic` is
what that session is about, in the professor's own words, short. `details` is
anything else attached to that row — readings, chapter numbers, "bring a
laptop", "no class" — or an empty string.

Set `is_assessment` true when the row IS an assessment: a quiz, test, midterm,
final, exam, presentation, or a stated submission deadline. A lecture that
merely mentions revision is not an assessment.

Dates:
- Resolve every row to a specific calendar day, using the year you are given
  when the document states only a day and a month.
- If a row states no date at all and you cannot work one out from the rows
  around it, leave that row out. A guessed day is worse than a missing one.
- Weeks numbered without dates ("Week 4") are not dates. Leave them out unless
  the document also states when Week 1 begins.

Return the rows in the order the document lists them.

Do not invent rows to fill a gap in a numbering. If the document is not a
timetable at all, return an empty list.
"""

_TIMETABLE_SCHEMA = {
    "type": "object",
    "properties": {
        "sessions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "topic": {"type": "string"},
                    "details": {"type": "string"},
                    "is_assessment": {"type": "boolean"},
                },
                "required": ["date", "topic"],
            },
        }
    },
    "required": ["sessions"],
}


async def extract_timetable(
    *, course_name: str, today: date, data: bytes, mime_type: str
) -> list[SessionRow]:
    """Every dated row a timetable states, in the order it states them.

    `today` is passed so that a document writing "27 August" with no year
    resolves against the term actually being lived in, rather than against
    whichever year the model would otherwise reach for.
    """
    out = await _generate_from_file(
        data=data,
        mime_type=mime_type,
        prompt=(
            f"Course: {course_name}\n"
            f"Today's date: {today.isoformat()}\n"
            "Assume the academic year containing today unless the document "
            "says otherwise.\n\nRead the attached timetable."
        ),
        schema=_TIMETABLE_SCHEMA,
        system=_TIMETABLE_SYSTEM,
    )

    raw = out.get("sessions")
    if not isinstance(raw, list):
        return []

    rows: list[SessionRow] = []
    # The same date and the same topic twice is one document read twice, not
    # two lectures. Two different topics on one date is ordinary — a lecture
    # and a quiz the same afternoon — so the date alone is not the key.
    seen: set[tuple[str, str]] = set()

    for item in raw:
        if not isinstance(item, dict):
            continue

        topic = (item.get("topic") or "").strip()
        try:
            on = date.fromisoformat((item.get("date") or "").strip())
        except (TypeError, ValueError):
            # A row the model could not pin to a day. The prompt asks for it
            # to be dropped; this is the check that does not depend on asking.
            continue
        if not topic:
            continue

        key = (on.isoformat(), topic.casefold())
        if key in seen:
            continue
        seen.add(key)

        rows.append(
            SessionRow(
                on_date=on.isoformat(),
                topic=topic[:300],
                details=(item.get("details") or "").strip()[:2000],
                is_assessment=bool(item.get("is_assessment")),
            )
        )

        if len(rows) == MAX_SESSIONS:
            break

    return rows


# ---------------------------------------------------------------------------
# Rubrics
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CriterionRow:
    """One graded component: what it is worth, and what it is out of.

    No score. A rubric states weights, not your marks — those you type in as
    they arrive, and no model is ever anywhere near them.
    """

    label: str
    weight: float
    max_score: float


MAX_CRITERIA = 30

_RUBRIC_SYSTEM = """\
You read one grading rubric or assessment breakdown a university professor
handed out, and return the components it grades on.

For each component:
- `label` is its name, as the document writes it: "Midterm", "Essay 1",
  "Class participation".
- `weight` is what percentage of the final grade it carries, as a number with
  no percent sign. If the document gives points rather than percentages and
  states a total, convert to a percentage of that total.
- `max_score` is what that component is marked out of — 20, 100, 5. If the
  document does not say, use 100.

Never return a score, a mark or a grade a student received, even if the
document shows one. You are reading what the course is worth, not how anybody
did in it.

If the document lists sub-criteria under a component, return the components
and not the sub-criteria — a weighted total is built from the things that
carry weight.

If the document is not a rubric or a grading breakdown, return an empty list.
"""

_RUBRIC_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "weight": {"type": "number"},
                    "max_score": {"type": "number"},
                },
                "required": ["label", "weight"],
            },
        },
    },
    "required": ["criteria"],
}


def _number(value: object, *, default: float | None = None) -> float | None:
    """A number the model sent, or the default.

    The schema asks for a number and usually gets one, but "30%" and "20" as
    strings both turn up, and a weight this function guessed at would be a
    weight that quietly makes every total wrong for the rest of term.
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().rstrip("%").strip())
        except ValueError:
            return default
    return default


async def extract_rubric(
    *, course_name: str, data: bytes, mime_type: str
) -> tuple[str, list[CriterionRow]]:
    """A rubric's title and its weighted components.

    The weights come back exactly as extracted, including when they do not sum
    to a hundred. Normalising them here would hide the most useful thing this
    screen can tell you — that a row is missing, or that the handout itself
    does not add up — behind numbers that merely look correct.
    """
    out = await _generate_from_file(
        data=data,
        mime_type=mime_type,
        prompt=f"Course: {course_name}\n\nRead the attached rubric.",
        schema=_RUBRIC_SCHEMA,
        system=_RUBRIC_SYSTEM,
    )

    raw = out.get("criteria")
    if not isinstance(raw, list):
        return "", []

    rows: list[CriterionRow] = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        label = (item.get("label") or "").strip()
        if not label:
            continue

        weight = _number(item.get("weight"), default=0.0) or 0.0
        # Out of range means misread, not clamp and carry on: a 300% component
        # is a number to fix by hand, and the review table is exactly where
        # that happens. Zero renders as an empty cell asking to be filled in.
        if not 0 <= weight <= 100:
            weight = 0.0

        max_score = _number(item.get("max_score"), default=100.0) or 100.0
        if max_score <= 0:
            max_score = 100.0

        rows.append(
            CriterionRow(
                label=label[:200],
                weight=round(weight, 3),
                max_score=round(max_score, 3),
            )
        )

        if len(rows) == MAX_CRITERIA:
            break

    title = (out.get("title") or "").strip()[:200]
    return title or f"{course_name} rubric"[:200], rows

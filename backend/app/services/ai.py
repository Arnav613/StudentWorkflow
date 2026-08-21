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
import io
import json
import re
from dataclasses import dataclass
from datetime import date, datetime

import httpx
import pypdf

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
    return await _generate_turns(
        [{"role": "user", "parts": [{"text": prompt}]}], schema, system=system
    )


async def _generate_turns(contents: list[dict], schema: dict, *, system: str) -> dict:
    """The same call, for the one feature that has more than one turn.

    Phase 13's planner is a conversation — "no, keep Wednesday free instead" is
    only meaningful against what was said before it — so the contents list is
    handed in rather than built from a single string. Everything else is
    unchanged and deliberately so: same schema discipline, same timeout, same
    single client. There is still exactly one place in this app that talks to a
    model.
    """
    settings = get_settings()
    if not settings.ai_ready:
        raise AiUnavailable("AI is turned off on this deployment")

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
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
You read Google Classroom announcements written by a university professor and
find every deadline they state.

You are given several announcements at once, each headed "--- Announcement N
(posted YYYY-MM-DD) ---". Read every one of them. They are separate posts that
happen to share a request: a date in one says nothing about any other, and you
must never carry a deadline from one announcement across to another. Tag each
deadline you return with the number of the announcement that states it.

Usually there are none, and that is the expected answer: return an empty list.
Sometimes there is one. Occasionally a post sets out a plan for the rest of
term and states several, and then you must return all of them — a professor
listing three dates in one paragraph is one post and three pieces of work.

Include only a due date the announcement itself states. A lecture time, an
office hour, a room change, a reading suggestion, a reminder of a deadline
with no date in it, and an encouragement to start early are all excluded.

If the announcement changes a date that already exists ("the essay is now due
Friday"), include it — a change is the case that matters most.

Resolve relative dates ("next Friday", "in two weeks") against the date its
own announcement was posted, which is given in that announcement's heading —
not against any other announcement's date. If you cannot resolve a date to a
specific calendar day, leave that one out. A guessed day is worse than no
answer.

Within one announcement, do not list the same deadline twice because it is
mentioned twice. Across announcements, do not deduplicate: if two posts each
state the same deadline, that is one deadline from each of them, and both are
returned under their own announcement number.

Order the deadlines from one announcement by how prominent they are in it,
most prominent first.

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


# How many announcements ride in one request.
#
# The ceiling is not the model's context, which is far larger. It is blast
# radius: one malformed answer costs every announcement in its batch a retry
# next hour, and a batch of twenty-five is a cheap hour to lose where a batch
# of four hundred is not. It is also what keeps the numbering the model has to
# track short enough that it does not lose count.
MAX_BATCH = 25

# The whole prompt's prose budget, not each announcement's.
#
# MAX_PROSE_CHARS still bounds any single post, so one wall of text cannot
# crowd out the twenty-four around it. This second ceiling is what stops
# twenty-five ordinary posts from adding up to an unbounded request.
MAX_BATCH_CHARS = 30000


# A date, in the shapes a professor actually writes one.
_DATE_HINT = re.compile(
    r"""
      \b\d{1,2}\s*[/-]\s*\d{1,2}              # 12/03, 3-11
    | \b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?      # 12th of March, 3 March
      (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)
    | (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}
    | \b(mon|tues|wednes|thurs|fri|satur|sun)day\b
    | \b(today|tomorrow|tonight|midnight|noon)\b
    | \bnext\s+week\b
    | \bin\s+(a|one|two|three|four)\s+weeks?\b
    | \bend\s+of\s+(the\s+)?(week|month|term|semester)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# The vocabulary of owing someone work by a certain time.
#
# The trailing `(e?s)?` is not tidiness. "Presentations will be held March 12"
# failed this gate while "presentation" passed it, and a plural that silently
# drops a deadline is the exact failure the whole filter is written to avoid.
_OBLIGATION_HINT = re.compile(
    r"""
    \b(
        due | deadline | submit | submission | hand\s?-?in | turn\s?in
      | upload | closes? | closing | cut\s?-?off | no\s+later\s+than
      | exam | midterm | final | quiz | test | assessment
      | assignment | essay | report | presentation | viva | lab\s+report
      | extended | postponed | moved | rescheduled | brought\s+forward
    )(e?s)?\b
    """,
    re.IGNORECASE | re.VERBOSE,
)


def might_state_a_deadline(text: str) -> bool:
    """Whether this announcement is worth a model's attention.

    Most announcements are a room change, a reading, an encouragement or a
    thank-you, and reading those was the largest single expense in the app: one
    request each, several hundred an hour on a first sync, against a free-tier
    quota that counts requests and does not care that the answer was empty.

    The gate is two cheap questions — does it name a time, and does it use the
    language of owing work — and both must pass. That conjunction is the whole
    design. "Office hours moved to Thursday" has a day and no obligation.
    "Please start the essay early" has an obligation and no day. Neither is a
    deadline, and neither now costs a request.

    It is deliberately loose in the direction that matters. A false positive
    costs one call that returns nothing, which is exactly the status quo. A
    false negative costs a deadline the student never sees, which is the one
    failure this app is not allowed — so both patterns lean toward letting
    things through.
    """
    prose = text.strip()
    if not prose:
        return False
    return bool(_DATE_HINT.search(prose) and _OBLIGATION_HINT.search(prose))


@dataclass(frozen=True)
class Announcement:
    """One post, as this module needs it: an identity, and prose with a date."""

    id: str
    posted_on: date
    text: str


_BATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "deadlines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "announcement": {
                        "type": "integer",
                        "description": "Number of the announcement this came from",
                    },
                    "title": {"type": "string"},
                    "due_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "excerpt": {"type": "string"},
                },
                "required": ["announcement", "title", "due_date"],
            },
        }
    },
    "required": ["deadlines"],
}


async def propose_deadlines(
    *, course_name: str, announcements: list[Announcement]
) -> dict[str, list[DeadlineProposal]]:
    """Every deadline stated across a batch of announcements, by announcement.

    One request reads many posts. The earlier version read exactly one, which
    was the honest shape of the problem and the wrong shape for the quota: a
    term's backlog on a first sync was several hundred requests inside a single
    cron run, nearly all of them answering "nothing here".

    Batching weakens no guarantee above it. Each proposal names the
    announcement it came from, so the caller still writes one row per deadline
    with its own `source_id` ordinal, its own accept and its own remembered no.
    What changes is only how many times we ask.

    The return is keyed by announcement id and is *sparse*: an announcement the
    model found nothing in is absent, not present-and-empty. Callers mark every
    announcement they sent as seen regardless, because "no deadline here" is a
    permanent answer whether it arrived as an empty list or as silence.

    A batch fails whole. Every announcement in it goes unmarked and the next
    hourly pass re-reads them — the same free retry the one-at-a-time version
    had, at a coarser grain.
    """
    batch = [a for a in announcements if a.text.strip()]
    if not batch:
        return {}

    if len(batch) > MAX_BATCH:
        # Chunked here rather than at the caller so the bound travels with the
        # prompt it protects. Each chunk is its own request and its own failure.
        out: dict[str, list[DeadlineProposal]] = {}
        for at in range(0, len(batch), MAX_BATCH):
            out.update(
                await propose_deadlines(
                    course_name=course_name, announcements=batch[at : at + MAX_BATCH]
                )
            )
        return out

    blocks: list[str] = []
    numbered: list[Announcement] = []
    budget = MAX_BATCH_CHARS

    for post in batch:
        prose = post.text.strip()[:MAX_PROSE_CHARS]
        if len(prose) > budget and numbered:
            # The budget is spent. What is left becomes another request rather
            # than being dropped — a truncated batch loses posts, and a lost
            # post is a lost deadline.
            break
        budget -= len(prose)
        numbered.append(post)
        blocks.append(
            f"--- Announcement {len(numbered)} "
            f"(posted {post.posted_on.isoformat()}) ---\n{prose}"
        )

    result = await _generate(
        f"Course: {course_name}\n\n" + "\n\n".join(blocks),
        _BATCH_SCHEMA,
        system=_DEADLINE_SYSTEM,
    )

    # Whatever the budget pushed out is a separate request, not a loss.
    overflow: dict[str, list[DeadlineProposal]] = {}
    if len(numbered) < len(batch):
        overflow = await propose_deadlines(
            course_name=course_name, announcements=batch[len(numbered) :]
        )

    raw = result.get("deadlines")
    if not isinstance(raw, list):
        return overflow

    found: dict[str, list[DeadlineProposal]] = {}
    # Deduped on what the proposal actually is, within one announcement. The
    # prompt asks for no repeats and mostly gets none; this is the check that
    # does not depend on asking.
    seen: set[tuple[str, str, str]] = set()

    for item in raw:
        if not isinstance(item, dict):
            continue

        index = item.get("announcement")
        if not isinstance(index, int) or not 1 <= index <= len(numbered):
            # A proposal that cannot say which post it came from cannot be
            # shown beside that post's words, and an excerpt nobody can check
            # against the professor is what the review queue exists to prevent.
            continue
        post = numbered[index - 1]

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

        key = (post.id, title.casefold(), parsed.isoformat())
        if key in seen:
            continue
        seen.add(key)

        into = found.setdefault(post.id, [])
        if len(into) == MAX_DEADLINES:
            continue

        into.append(
            DeadlineProposal(
                title=title[:200],
                due_at=parsed.isoformat(),
                excerpt=(item.get("excerpt") or "").strip()[:500],
            )
        )

    found.update(overflow)
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


# Below this, slicing is not worth the risk of guessing wrong.
#
# A three-page handout costs 774 tokens whole. Picking two of those pages saves
# 258 and introduces a way to drop the one that mattered, which is a bad trade.
# The savings only become real on the long documents — a course pack with the
# schedule buried on page 31 — and that is where this is aimed.
MIN_PAGES_TO_SLICE = 5

# The ceiling on what a slice may send.
#
# Generous on purpose. A timetable that runs across four pages is ordinary and
# a rubric with an appendix of descriptors is ordinary, and a slice that cuts
# either in half is worse than not slicing. This bounds the pathological case —
# a document where every page looks relevant — not the normal one.
MAX_PAGES_KEPT = 8

# What a page about *when things happen* looks like.
_TIMETABLE_PAGE_HINT = re.compile(
    r"""
      \b\d{1,2}\s*[/-]\s*\d{1,2}
    | \b(mon|tues|wednes|thurs|fri|satur|sun)day\b
    | (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}
    | \bweek\s*\d{1,2}\b
    | \b(lecture|seminar|tutorial|lab|workshop|session|topic)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# What a page about *what counts for how much* looks like.
_RUBRIC_PAGE_HINT = re.compile(
    r"""
      \d{1,3}\s*%
    | \b(weight|weighting|weighted|marks?|mark\s+scheme|grading|graded)\b
    | \b(rubric|criteri(a|on)|assessment|component|breakdown)\b
    | \bout\s+of\s+\d{1,3}\b
    | \b(total|overall)\s+(grade|mark|score)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _slice_pdf(data: bytes, hint: re.Pattern[str]) -> tuple[bytes, int, int] | None:
    """The pages of a PDF that look like they answer the question, or nothing.

    Gemini bills a PDF at a flat rate per page and does not charge for the text
    it pulls out, so the only way to make a long document cheaper is to send
    fewer pages of it. A forty-page course pack whose schedule lives on pages
    eleven and twelve costs forty pages to read two, every time someone presses
    the button.

    So the text is extracted here, locally and for free, and used for one thing
    only: deciding which pages to send. It is never what the model reads. That
    distinction is what makes a crude extractor good enough — the page numbers
    survive a mangled table where the table's contents would not, and the model
    still sees the real page, laid out, with its lines and columns intact.

    Returns `(pdf, kept, total)`, or `None` meaning "send the original". None is
    the answer for everything uncertain: an encrypted file, a damaged one, a
    short one, a scan with no text layer, and a document where every page looks
    relevant. Each of those is a case where slicing either saves nothing or
    risks cutting the page the answer was on, and the whole document is always
    a correct thing to send.
    """
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            # Some encrypted PDFs open with an empty password, but one that
            # does not would raise deep inside the page loop below. Not worth
            # the branch: send it whole and let the model deal with it.
            return None
        pages = reader.pages
        total = len(pages)
        if total < MIN_PAGES_TO_SLICE:
            return None

        scores: list[int] = []
        for page in pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                # One unreadable page in an otherwise fine document. Scored
                # zero rather than aborting the slice.
                text = ""
            scores.append(len(hint.findall(text)))
    except Exception:
        # Damaged, or not really a PDF. The model gets the original bytes and
        # gives the user a better error than this function could.
        return None

    if not any(scores):
        # No text layer at all, or nothing that looks like an answer. A scanned
        # timetable is exactly this case, and it is precisely the document that
        # must go to the model whole — its pages are images and only the model
        # can read them.
        return None

    # Rank by score, keep the best, then put them back in reading order. A
    # rubric read back to front is a rubric the model has to reassemble.
    ranked = sorted(range(total), key=lambda n: (-scores[n], n))
    keep = sorted(n for n in ranked[:MAX_PAGES_KEPT] if scores[n])

    if len(keep) >= total:
        # Every page looked relevant, so there is nothing to save and a
        # re-encoded copy of the file is strictly worse than the file.
        return None

    try:
        writer = pypdf.PdfWriter()
        for n in keep:
            writer.add_page(pages[n])
        buffer = io.BytesIO()
        writer.write(buffer)
    except Exception:
        return None

    out = buffer.getvalue()
    if not out or len(out) >= len(data):
        # Rewriting made it bigger — a PDF whose bulk is one shared font, say.
        # The page count is what is billed, so this is not a failure, but it is
        # close enough to no gain that the original is the simpler answer.
        return None

    return out, len(keep), total


async def _generate_from_file(
    *,
    data: bytes,
    mime_type: str,
    prompt: str,
    schema: dict,
    system: str,
    page_hint: re.Pattern[str] | None = None,
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

    # Trimmed after the size checks, not before: the bound that matters is on
    # what the user uploaded, and a slice that shrinks a file under the limit
    # would turn "too large to read" into a silent partial read.
    if page_hint is not None and mime_type == "application/pdf":
        sliced = _slice_pdf(data, page_hint)
        if sliced is not None:
            data, _kept, _total = sliced

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
        page_hint=_TIMETABLE_PAGE_HINT,
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
        page_hint=_RUBRIC_PAGE_HINT,
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
# ---------------------------------------------------------------------------
# Arguing with the planner — phase 13
# ---------------------------------------------------------------------------
#
# The rule this section enforces, and the only one that matters: **the model
# may do what a person sitting at the week can do, and nothing else.** Every
# edit kind below has a counterpart the student could perform by hand on the
# grid — set an estimate, drag a session to another hour, take one off the
# board, place one that had no hour against it. There is no edit here that
# invents a mechanism the interface does not already offer, because an edit
# nobody can perform by hand is one nobody can undo by hand either.
#
# That cuts both ways, and the removals matter as much as the additions.
# Splitting a task, blacking out an afternoon and deferring work to next week
# were all things only the model could do. They are gone. A model that is the
# sole author of a piece of state is a model whose decisions you cannot argue
# with using the app itself.
#
# Everything below is a bound on that. The four edit kinds are a closed set,
# `_clean_edits` drops anything outside it, and an id the browser did not send
# is not a task and not a block.

# A week's worth. Beyond this the prompt is a bill rather than a week, and
# nobody has sixty live tasks they are willing to discuss in one sentence.
MAX_PLAN_TASKS = 60

# The grid holds more rows than the rail does — every routine occurrence and
# every mirrored lecture is an hour the model has to plan around, not just the
# work it may move.
MAX_PLAN_BLOCKS = 120

# Nobody has forty standing commitments. This is a runaway guard, not a limit
# anybody will meet.
MAX_PLAN_ROUTINES = 40

_WEEKDAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
]

# The conversation dies with the tab, but it should not grow without limit
# inside it either — a long argument is re-sent whole on every turn.
MAX_TURNS = 12
MAX_TURN_CHARS = 1000

# What a single answer may propose. A reply rewriting thirty things is not a
# reply to "I am dead on Wednesday", it is a new plan wearing a diff's clothes.
MAX_EDITS = 12

_PLAN_SYSTEM = """\
You help a university student rearrange their week.

Everything you propose is a change the student could have made themselves by
hand on the grid, and nothing else. You are shown their tasks and every block
currently on their week, and you answer with a list of edits they then accept
or refuse. Nothing you say takes effect until they press accept.

The first four kinds are about work - one task, one hour:

  estimate     - set how many minutes a task takes. Use this when a task has
                 no estimate, or when the student tells you one is wrong.
  move_block   - move one existing block to a different day or time. This is
                 the same thing as dragging it. Give the block's id and the
                 new start and end. Keep the block's length unless the student
                 asks for a different one.
  unplan_block - take one existing block off the grid. The work is not done
                 and not deleted; it goes back to the unplanned list with no
                 hour against it. Use this when the student says a session is
                 not happening.
  place_task   - give an unplanned task an hour, by creating a block for it.
                 Give the task's id and a start and end. This is the same
                 thing as dragging it out of the unplanned list onto a day.

The other five are about repeating blocks - the standing commitments that come
back every week. Gym, a shift, a rehearsal, dinner with someone. They are not
tasks: they never get ticked off and they have no deadline, they simply happen
again:

  add_routine  - a new repeating block. Give a `title`, a `time_of_day` as
                 "HH:MM", how many `minutes` it lasts, and a `weekday` - 0 for
                 Sunday through 6 for Saturday, or leave it out for something
                 that happens every day.
                 One weekday per edit. "Gym on Monday, Wednesday and Friday"
                 is three of these, one per day, exactly as the student would
                 add them by hand.
  retime_routine   - a repeating block now happens at a different time. Give
                 the routine's id and the new `time_of_day`. Add a `weekday`
                 to change only that one day and leave the rest alone; leave
                 it out to change every day the routine runs.
  skip_routine_weekday - a repeating block no longer happens on one particular
                 weekday, but continues on the others. Give the routine's id
                 and the `weekday`. Only for a routine that runs every day -
                 for one that already runs on a single weekday, dropping that
                 weekday is just removing it, so use remove_routine and say so.
  skip_routine_once - one single occurrence is not happening. Give the
                 routine's id and the `on_date` as "YYYY-MM-DD". The routine
                 itself is untouched and comes back the following week.
  remove_routine - the repeating block is gone for good, on every day it ran.

Hard rules:

- You never change a due date. You have no way to and must not claim to.
- You cannot change how long a repeating block lasts once it exists. Its time
  can move and its days can change, but its length is fixed at the moment it
  is created; say so rather than proposing something else.
- Do not turn work into a repeating block. "Revise every evening" is several
  sessions of a task, not a routine - a routine is never ticked off, and work
  that never gets ticked off is work the board stops tracking.
- You never touch grades, notes, or anything not in the week you were given.
- Only use task ids and block ids that appear in the week you were given.
- Only blocks marked `movable` may be moved or unplanned. A lecture from the
  student's calendar and a recurring routine are not yours to touch; if the
  student wants one gone they must do it themselves, and you should say so.
- Times are ISO 8601 with an offset, and must fall inside the planning
  horizon you were given.
- Never put work after its own deadline. If a block cannot fit before the
  task is due, do not propose it anywhere — say plainly that it will not fit
  in time, and leave it to the student.
- Do not put two blocks on top of each other, and do not put work on top of a
  routine or a lecture. Use the hours that are free.
- If a request is vague, ask a short question in `message` and return no
  edits. An empty edit list is a perfectly good answer.
- If the student asks for something you cannot express with these four kinds,
  say so plainly in `message` and return no edits. Do not approximate it with
  an edit that means something else. In particular you cannot split a task in
  two, cannot mark hours unavailable, and cannot push work into a later week -
  say so rather than doing something that resembles it.
- A repeating block is a real commitment in the student's life, not a way of
  reserving time. If they want an hour held for something, that is a routine
  only if it genuinely happens every week.
- Every edit carries `why` - one short clause naming the reason, in the
  student's own terms. It is shown next to the edit before they accept it.

`message` is two or three sentences at most, addressed to the student, saying
what you changed and what it will cost them. Do not list the edits in prose;
they are shown as a list underneath. If the week still will not fit after your
edits, say that.
"""

_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "message": {"type": "string"},
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": [
                            "estimate",
                            "move_block",
                            "unplan_block",
                            "place_task",
                            "add_routine",
                            "retime_routine",
                            "skip_routine_weekday",
                            "skip_routine_once",
                            "remove_routine",
                        ],
                    },
                    "why": {"type": "string"},
                    "task_id": {"type": "string"},
                    "block_id": {"type": "string"},
                    "routine_id": {"type": "string"},
                    "title": {"type": "string"},
                    "weekday": {"type": "integer"},
                    "time_of_day": {"type": "string"},
                    "on_date": {"type": "string"},
                    "minutes": {"type": "integer"},
                    "starts_at": {"type": "string"},
                    "ends_at": {"type": "string"},
                },
                "required": ["kind", "why"],
            },
        },
    },
    "required": ["message", "edits"],
}


@dataclass(frozen=True)
class PlanEdit:
    """One change to the week, of a kind a person could have made by hand.

    Deliberately one flat shape rather than four classes. It crosses two
    process boundaries as JSON and is rendered by one list component; four
    payload types would buy type safety in the middle of a pipeline whose ends
    are both untyped anyway, and would cost the browser a discriminated union
    for four rows on a screen.
    """

    kind: str
    why: str
    task_id: str | None = None
    block_id: str | None = None
    routine_id: str | None = None
    #: On `add_routine` only. Everything else names something already there.
    title: str | None = None
    #: 0 = Sunday. None on a routine edit means "every day it runs".
    weekday: int | None = None
    time_of_day: str | None = None
    on_date: str | None = None
    minutes: int | None = None
    starts_at: str | None = None
    ends_at: str | None = None


@dataclass(frozen=True)
class PlanRoutine:
    """A standing commitment, as the model needs to see it.

    `weekday` is the whole of the recurrence: None means every day, and an
    integer means that one day of the week. There is no richer pattern in this
    app — "Monday, Wednesday and Friday" is three rows, because that is how
    the form the student uses writes it, and a model that could express in one
    edit what a person needs three of would be a model whose diffs cannot be
    checked against the screen.
    """

    id: str
    title: str
    weekday: int | None
    time_of_day: str
    duration_minutes: int


@dataclass(frozen=True)
class PlanTask:
    """A task, as the planner sees it. Not as the board sees it.

    No description, no notes, no checklist, no source, no Classroom id. The
    week is what is being discussed and the week is title, class, deadline and
    length - everything else is a wider leak bought for no better answer.
    """

    id: str
    title: str
    class_name: str
    due_at: str | None
    estimate_minutes: int | None
    planned_minutes: int


@dataclass(frozen=True)
class PlanBlock:
    """An hour already spoken for, and whether the model may speak for it.

    `movable` is the whole reason this type exists rather than a bare list of
    intervals. A work session is the student's to drag and therefore the
    model's to propose dragging; a lecture mirrored from Google and a
    recurring routine are neither. Both still occupy time, so both are sent —
    what changes is only whether an edit may name them.
    """

    id: str
    label: str
    task_id: str | None
    starts_at: str
    ends_at: str
    movable: bool


@dataclass(frozen=True)
class PlanAdvice:
    message: str
    edits: list[PlanEdit]


# Bounds on a single edit, applied after the model has spoken. The schema
# constrains shape; these constrain sense.
MIN_EDIT_MINUTES = 5
MAX_EDIT_MINUTES = 8 * 60


def _edit_minutes(value: object) -> int | None:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not MIN_EDIT_MINUTES <= n <= MAX_EDIT_MINUTES:
        return None
    # To the five minutes the pickers already offer. A 37-minute estimate is
    # not more accurate than 35, it is only harder to believe.
    return max(MIN_EDIT_MINUTES, round(n / 5) * 5)


# A repeating block may be longer than a study session — a shift is eight
# hours and a rehearsal can be four. The task bound above is deliberately
# tighter, and this is the one the routine form itself enforces.
MAX_ROUTINE_MINUTES = 16 * 60


def _routine_minutes(value: object) -> int | None:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not MIN_EDIT_MINUTES <= n <= MAX_ROUTINE_MINUTES:
        return None
    return max(MIN_EDIT_MINUTES, round(n / 5) * 5)


def _weekday(value: object) -> int | None:
    """0 for Sunday through 6 for Saturday, matching `Date.getDay()`.

    Anything else is nothing rather than a clamp. A model that meant Thursday
    and said 7 has made a mistake, and Sunday is not a better guess at what it
    meant than silence is.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= 6 else None


def _time_of_day(value: object) -> str | None:
    """"HH:MM", on the 24-hour clock, or nothing.

    Seconds are trimmed rather than refused — a model that answers "18:00:00"
    has said exactly the right thing in a slightly wrong shape — but a value
    that is not a real time of day is dropped, because a routine at 25:00 is a
    row nothing on the grid can draw.
    """
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def _instant(value: object) -> datetime | None:
    """An ISO string with an offset, or nothing.

    A local time with no offset is an hour the server would have to guess at,
    and it would guess UTC — which is five and a half hours away from everyone
    this app is for. So a naive timestamp is not a lenient case to normalise,
    it is a wrong answer, and it is dropped.
    """
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def _span(
    item: dict, *, horizon: tuple[datetime, datetime]
) -> tuple[datetime, datetime] | None:
    """The start and end of a proposed block, or nothing if it makes no sense.

    Four ways to fail and all of them silent: no offset, backwards, a length
    outside what the pickers offer, or an hour outside the week being
    discussed. A block in November changes nothing about this week and would
    sit on the grid saying nothing.
    """
    begins = _instant(item.get("starts_at"))
    finishes = _instant(item.get("ends_at"))
    if not begins or not finishes or finishes <= begins:
        return None

    length = int((finishes - begins).total_seconds() // 60)
    if not MIN_EDIT_MINUTES <= length <= MAX_EDIT_MINUTES:
        return None

    start, end = horizon
    if begins < start or finishes > end:
        return None
    return begins, finishes


def _clean_edits(
    raw: object,
    *,
    tasks: dict[str, PlanTask],
    blocks: dict[str, PlanBlock],
    routines: dict[str, PlanRoutine],
    horizon: tuple[str, str],
) -> list[PlanEdit]:
    """Everything the model said, minus everything it was not allowed to say.

    This function is the fence, and it assumes nothing about the prompt above
    it holding. An id that was never sent is not a task and not a block; a
    lecture is not movable however politely the model asks; an hour past a
    deadline is not an hour this app will offer to schedule work in; and an
    edit missing the field that gives it meaning is dropped rather than
    defaulted, because a defaulted estimate is the app inventing a number and
    attributing it to a model.
    """
    if not isinstance(raw, list):
        return []

    bounds = (horizon_start(horizon[0]), horizon_start(horizon[1]))
    out: list[PlanEdit] = []

    def in_time(task_id: str | None, begins: datetime) -> bool:
        """Work is not scheduled after it is due.

        The student may do that by hand — a deadline missed is still a decision
        they are allowed to make, and the grid marks it Late when they do. The
        model proposing it would be different: the app suggesting a plan it
        already knows cannot work.
        """
        task = tasks.get(task_id or "")
        due = _instant(task.due_at) if task and task.due_at else None
        return not due or begins < due

    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "")
        why = str(item.get("why") or "").strip()[:200]

        task_id = item.get("task_id")
        task_id = task_id if isinstance(task_id, str) and task_id in tasks else None

        routine_id = item.get("routine_id")
        routine = routines.get(routine_id) if isinstance(routine_id, str) else None

        block_id = item.get("block_id")
        block = blocks.get(block_id) if isinstance(block_id, str) else None
        # Sent for context, not for editing. A routine occurrence and a
        # mirrored lecture are hours the model plans around.
        if block and not block.movable:
            block = None

        if kind == "estimate":
            minutes = _edit_minutes(item.get("minutes"))
            if task_id and minutes:
                out.append(PlanEdit(kind, why, task_id=task_id, minutes=minutes))

        elif kind == "move_block":
            span = _span(item, horizon=bounds)
            if block and span and in_time(block.task_id, span[0]):
                out.append(
                    PlanEdit(
                        kind,
                        why,
                        block_id=block.id,
                        task_id=block.task_id,
                        starts_at=span[0].isoformat(),
                        ends_at=span[1].isoformat(),
                    )
                )

        elif kind == "unplan_block":
            if block:
                out.append(
                    PlanEdit(kind, why, block_id=block.id, task_id=block.task_id)
                )

        elif kind == "place_task":
            span = _span(item, horizon=bounds)
            if task_id and span and in_time(task_id, span[0]):
                out.append(
                    PlanEdit(
                        kind,
                        why,
                        task_id=task_id,
                        starts_at=span[0].isoformat(),
                        ends_at=span[1].isoformat(),
                    )
                )

        elif kind == "add_routine":
            title = str(item.get("title") or "").strip()[:200]
            when = _time_of_day(item.get("time_of_day"))
            minutes = _routine_minutes(item.get("minutes"))
            # `weekday` absent is meaningful here and only here: it is how the
            # form says "every day". So a missing value is kept as None, and
            # only a value that is present and wrong drops the edit.
            weekday = _weekday(item.get("weekday"))
            if "weekday" in item and item["weekday"] is not None and weekday is None:
                continue
            if title and when and minutes:
                out.append(
                    PlanEdit(
                        kind,
                        why,
                        title=title,
                        weekday=weekday,
                        time_of_day=when,
                        minutes=minutes,
                    )
                )

        elif kind == "retime_routine":
            when = _time_of_day(item.get("time_of_day"))
            if not routine or not when:
                continue
            weekday = _weekday(item.get("weekday"))
            # A routine that already runs on one weekday has nothing to make an
            # exception to — see `applyScope`, which quietly widens the same
            # case. Widening it here too keeps the diff row honest: it will say
            # "every Tuesday" because that is all there is.
            if routine.weekday is not None:
                weekday = None
            out.append(
                PlanEdit(
                    kind,
                    why,
                    routine_id=routine.id,
                    weekday=weekday,
                    time_of_day=when,
                )
            )

        elif kind == "skip_routine_weekday":
            weekday = _weekday(item.get("weekday"))
            # Refused, not translated, for a routine that runs on one day only.
            # Dropping the single day a rule applies to is deleting the rule,
            # and a row that said "no gym on Thursdays" while deleting gym
            # outright is the one kind of diff this whole step exists to
            # prevent. The model is told to use remove_routine and say so.
            if not routine or weekday is None or routine.weekday is not None:
                continue
            out.append(
                PlanEdit(kind, why, routine_id=routine.id, weekday=weekday)
            )

        elif kind == "skip_routine_once":
            on_date = item.get("on_date")
            if not routine or not isinstance(on_date, str):
                continue
            try:
                day = date.fromisoformat(on_date.strip()[:10])
            except ValueError:
                continue
            # Inside the week being discussed. Skipping an occurrence in
            # November is a decision about a week nobody is looking at.
            if not (bounds[0].date() <= day <= bounds[1].date()):
                continue
            out.append(
                PlanEdit(kind, why, routine_id=routine.id, on_date=day.isoformat())
            )

        elif kind == "remove_routine":
            if routine:
                out.append(PlanEdit(kind, why, routine_id=routine.id))

        if len(out) == MAX_EDITS:
            break

    return out


def horizon_start(value: str) -> datetime:
    """One of the two horizon bounds, as an instant.

    They arrive from the browser as ISO strings with an offset — the student's
    own midnight and the same midnight seven days later — because the horizon
    is a fact about the tab's timezone and this server has no opinion about
    where anyone is sitting.
    """
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise AiError("The planning horizon arrived without a timezone")
    return parsed


async def plan_advice(
    *,
    tasks: list[PlanTask],
    blocks: list[PlanBlock],
    routines: list[PlanRoutine],
    unplaced: list[str],
    horizon: tuple[str, str],
    turns: list[tuple[str, str]],
) -> PlanAdvice:
    """One turn of the argument.

    Stateless, like everything else in this file. The whole conversation is
    handed in on every call and nothing about it is remembered here or written
    down anywhere — see PLAN.md: a term of chat about which weeks went badly is
    a far more revealing document than the task list it describes, and it is
    worth nothing the next morning.

    `turns` is (role, text), oldest first, ending with what was just typed. The
    week is appended to that last turn rather than sent as a preamble, because
    it changes every time an edit is accepted and the freshest copy is the one
    that has to win.
    """
    if not turns:
        raise AiError("Nothing was asked")

    kept = tasks[:MAX_PLAN_TASKS]
    on_grid = blocks[:MAX_PLAN_BLOCKS]
    kept_routines = routines[:MAX_PLAN_ROUTINES]
    week = {
        "planning_from": horizon[0],
        "planning_to": horizon[1],
        "tasks": [
            {
                "id": t.id,
                "title": t.title[:200],
                "class": t.class_name[:100],
                "due": t.due_at,
                "estimate_minutes": t.estimate_minutes,
                "already_planned_minutes": t.planned_minutes,
            }
            for t in kept
        ],
        "blocks": [
            {
                "id": b.id,
                "what": b.label[:200],
                "task_id": b.task_id,
                "from": b.starts_at,
                "to": b.ends_at,
                "movable": b.movable,
            }
            for b in on_grid
        ],
        "routines": [
            {
                "id": r.id,
                "title": r.title[:200],
                # Named rather than numbered. The model answers with the
                # number, but it reads the week far better when the week says
                # "Tuesday" — and the two cannot drift, because this line is
                # the only place the mapping is written down.
                "day": "every day" if r.weekday is None else _WEEKDAY_NAMES[r.weekday],
                "weekday": r.weekday,
                "at": r.time_of_day,
                "minutes": r.duration_minutes,
            }
            for r in kept_routines
        ],
        "not_fitting": unplaced[:40],
    }

    recent = turns[-MAX_TURNS:]
    contents: list[dict] = []
    for role, text in recent[:-1]:
        contents.append(
            {
                "role": "model" if role == "model" else "user",
                "parts": [{"text": text[:MAX_TURN_CHARS]}],
            }
        )

    last = recent[-1][1][:MAX_TURN_CHARS]
    contents.append(
        {
            "role": "user",
            "parts": [
                {
                    "text": (
                        "The week as it currently stands:\n"
                        + json.dumps(week, separators=(",", ":"))
                        + "\n\nWhat I want:\n"
                        + last
                    )
                }
            ],
        }
    )

    out = await _generate_turns(contents, _PLAN_SCHEMA, system=_PLAN_SYSTEM)

    edits = _clean_edits(
        out.get("edits"),
        tasks={t.id: t for t in kept},
        blocks={b.id: b for b in on_grid},
        routines={r.id: r for r in kept_routines},
        horizon=horizon,
    )
    message = str(out.get("message") or "").strip()[:1200]
    if not message:
        # Silence with a diff attached is the one answer that must never reach
        # a screen: the whole approval step depends on being told what it is
        # you are about to agree to.
        message = (
            "Here is what I would change."
            if edits
            else "I could not work out what to change from that."
        )
    return PlanAdvice(message=message, edits=edits)

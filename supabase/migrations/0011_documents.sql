-- 0011_documents.sql — Phase 10. Upload, extract, confirm; two schemas.
--
-- PLAN.md called this file 0007 and settled it in one paragraph. Two things
-- about it changed on contact with the actual documents.
--
--   **Timetable entries are not tasks.** The plan said a dated thing attached
--   to a class is what a task already is, so `source = 'timetable'` would let
--   the board, the planner and the forecast carry it for free. That is true
--   of a deadline and false of a lecture. A professor's timetable is forty
--   rows of "Aug 27 — pointers, read ch. 3", and not one of those is a thing
--   you tick off. On the board they would bury the twelve cards that are real
--   work under forty that are not, and the forecast — which counts hours owed
--   — would be wrong by a factor of four. So the schedule gets a table whose
--   rows are read, never completed, and `tasks` is untouched: no new source,
--   no relaxed constraint, nothing on the board that a person or Classroom
--   did not put there.
--
--   **The schedule has to reach the week.** A timetable is only worth reading
--   if, on the Wednesday, the app can say what Wednesday's lecture is about.
--   The week already draws lectures — as mirrored Google Calendar events —
--   but nothing connects "CS201 Lecture" in a calendar to the CS 201 on the
--   dashboard. `class_event_links` is that connection, and it is asked for
--   once per recurring series rather than once per lecture.
--
-- What did not change: nothing a model extracted writes on its own.
-- `/ai/extract` returns rows to an editable table and the browser writes them
-- on Confirm — the top-of-PLAN.md rule with the review step on screen instead
-- of in `proposals`, because a scanned handout is wrong in ways only the
-- person holding it can see, and they are holding it right now.

-- ---------------------------------------------------------------------------
-- class-docs — a private bucket, policies copied from 0003 exactly
-- ---------------------------------------------------------------------------
--
-- Private for the reason note-images is private: a rubric with your marks on
-- it is not a thing to leave behind a guessable URL. Objects are keyed
-- `<user_id>/<class_id>/<random>.<ext>` and the first segment is the whole
-- access rule.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'class-docs',
  'class-docs',
  false,
  -- 15 MB. A phone photo of a handout is 3–5 MB and a scanned syllabus rarely
  -- passes 10. The ceiling is also what keeps a document inlineable in a
  -- single request to Gemini, which is why it is not larger.
  15728640,
  array[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp', 'image/heic'
  ]
)
on conflict (id) do nothing;

create policy class_docs_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'class-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy class_docs_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'class-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy class_docs_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'class-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy class_docs_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'class-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- class_documents — the file itself, kept
-- ---------------------------------------------------------------------------
--
-- Extraction is not a one-way door. The rows below are editable and will be
-- edited, and "what did the handout actually say?" has to stay answerable —
-- otherwise a correction made in the wrong direction is permanent. The file
-- stays, it renders in the tab that owns it, and Re-extract is a button
-- rather than another upload.
create table class_documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  class_id     uuid not null references classes (id) on delete cascade,

  -- Which tab owns it and which prompt reads it. Two kinds, one pipeline:
  -- the upload, the model call and the confirm step are the same code, and
  -- only the schema at the far end differs.
  kind         text not null check (kind in ('timetable', 'rubric')),

  title        text not null default '' check (length(title) <= 200),

  -- The object path in `class-docs`, never a URL. The rule note images set in
  -- 0003: a signed URL written into a row rots, and the rot surfaces weeks
  -- later as a document that will not open.
  storage_path text not null check (length(storage_path) > 0),
  mime_type    text not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index class_documents_class_idx
  on class_documents (class_id, kind, created_at desc);

create trigger class_documents_updated_at
  before update on class_documents
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- class_sessions — the schedule, read but never completed
-- ---------------------------------------------------------------------------
create table class_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  class_id      uuid not null references classes (id) on delete cascade,

  -- Null once the document it came from is deleted, and the session survives
  -- that. You may well have corrected these rows by hand, and throwing away a
  -- scan you no longer need is not a statement about the term's schedule.
  document_id   uuid references class_documents (id) on delete set null,

  -- A local calendar date. "The lecture on the 27th" is a statement about a
  -- day in the city you are standing in, not an instant — the same reasoning
  -- routine_skips gives in 0009.
  on_date       date not null,

  topic         text not null default '' check (length(topic) <= 300),

  -- Readings, chapters, "bring a laptop". Free text because a timetable's
  -- second column is free text, and splitting it into fields would be the app
  -- inventing a structure the professor did not use.
  details       text check (details is null or length(details) <= 2000),

  -- "Quiz 1" and "Midterm" are rows in this table too, flagged rather than
  -- moved. They stay schedule and never become board cards: a starred row is
  -- a warning you read on the way past, and adding the revision task is
  -- yours. This is the deliberate reversal at the top of the file.
  is_assessment boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The two questions this table answers: one class's whole term, and "what is
-- on in this class today", asked from the week grid across every class.
create index class_sessions_class_idx on class_sessions (class_id, on_date);
create index class_sessions_date_idx  on class_sessions (user_id, on_date);

create trigger class_sessions_updated_at
  before update on class_sessions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- rubrics and rubric_criteria — weights now, marks as they arrive
-- ---------------------------------------------------------------------------
create table rubrics (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  class_id    uuid not null references classes (id) on delete cascade,
  document_id uuid references class_documents (id) on delete set null,

  title       text not null default '' check (length(title) <= 200),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index rubrics_class_idx on rubrics (class_id, created_at);

create trigger rubrics_updated_at
  before update on rubrics
  for each row execute function set_updated_at();

create table rubric_criteria (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  rubric_id  uuid not null references rubrics (id) on delete cascade,

  label      text not null default '' check (length(label) <= 200),

  -- Percent of the final grade. Numeric, not integer: 12.5% is a real weight
  -- and rounding it would make the total wrong by the end of term.
  weight     numeric(6, 3) not null default 0 check (weight >= 0 and weight <= 100),

  -- What this component is out of — 20, 100, 5. Not assumed to be 100: a
  -- rubric that says 18/20 and an app that reads it as 18% is the single most
  -- damaging thing this table could get wrong.
  max_score  numeric(8, 3) not null check (max_score > 0),

  -- NULL IS UNGRADED, AND UNGRADED IS NOT ZERO. It renders as an em dash,
  -- never as 0, and it is left out of the weighted total rather than dragging
  -- it down — which is why lib/grades.ts states the total as a share of what
  -- has been graded so far. A midterm you have not sat is not a midterm you
  -- failed.
  score      numeric(8, 3) check (score is null or score >= 0),

  position   integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rubric_criteria_rubric_idx on rubric_criteria (rubric_id, position);

create trigger rubric_criteria_updated_at
  before update on rubric_criteria
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- class_event_links — which calendar series is which class
-- ---------------------------------------------------------------------------
--
-- Asked once, per *series*. Google expands a recurring lecture into one row
-- per occurrence (`singleEvents`, see services/google.py), so keying this on
-- the occurrence id would ask the same question every Monday for a term. The
-- series id — `recurringEventId`, falling back to the event's own id for a
-- one-off — is the part that is actually stable.
--
-- The link is the user's answer, not a guess the app kept: the picker
-- suggests a match on the title and a person confirms it. Matching silently
-- would put the wrong class's topic on the wrong lecture with nothing on
-- screen to explain why, which is worse than showing nothing at all.
create table class_event_links (
  user_id          uuid not null references users (id) on delete cascade,
  google_series_id text not null,

  -- Cascades: remove the class and the answer goes with it, so re-adding the
  -- course asks again rather than reviving a link to a row that is gone.
  class_id         uuid not null references classes (id) on delete cascade,

  created_at       timestamptz not null default now(),

  primary key (user_id, google_series_id)
);

create index class_event_links_class_idx on class_event_links (class_id);

-- The series an occurrence belongs to, carried on the mirror so the grid can
-- resolve the link without going back to Google. Null on every block that is
-- not an event, and on event rows mirrored before this migration — those pick
-- it up on the next calendar refresh.
alter table plan_blocks add column google_series_id text;

alter table plan_blocks add constraint plan_blocks_series_only_on_events check (
  google_series_id is null or google_event_id is not null
);

-- ---------------------------------------------------------------------------
-- RLS. Owner-only on all five, one `*_all_own` policy each.
-- ---------------------------------------------------------------------------

alter table class_documents   enable row level security;
alter table class_sessions    enable row level security;
alter table rubrics           enable row level security;
alter table rubric_criteria   enable row level security;
alter table class_event_links enable row level security;

create policy class_documents_all_own on class_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy class_sessions_all_own on class_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy rubrics_all_own on rubrics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy rubric_criteria_all_own on rubric_criteria
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy class_event_links_all_own on class_event_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

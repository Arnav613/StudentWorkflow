-- 0010_ai.sql — Phase 09. Announcements, linked docs, and one review queue.
--
-- PLAN.md called this file 0006. Five migrations for phases 07 and 08 landed
-- in between, so it is 0010; the number is a sequence, not a name.
--
-- Three tables' worth of change, for two very different mechanisms that phase
-- 09 deliberately keeps apart:
--
--   A Drive attachment is a fact. Classroom already hands us a structured
--   `materials[]` array on every announcement and every coursework item, so
--   ingesting it needs no model, no confidence and no approval — it writes
--   straight into class_links, deduped on the id Google gave it.
--
--   A deadline hidden in prose is a guess. "Essay moved to Friday" in the
--   body of an announcement is exactly the thing a model is good at spotting
--   and exactly the thing that must never write a due date on its own. It
--   lands in `proposals` and waits for a person.
--
-- The third table exists so the guess is only ever paid for once.

-- ---------------------------------------------------------------------------
-- proposals — what a model thinks, held at arm's length
-- ---------------------------------------------------------------------------
--
-- The generic shape is on purpose and is the app's one rule about AI made
-- into a table: every future model output gets a row here, not a write path
-- of its own. Phase 09 fills in exactly one `kind`; phases 10 and 13 will add
-- their own without another migration shaped like this one.
--
-- `payload` is jsonb because each kind has a different schema and a column
-- per kind would be a table of mostly-nulls. The frontend renders a payload
-- it recognises and ignores one it does not — a proposal kind added by a
-- newer backend must never crash an older tab.
create table proposals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,

  -- Nullable, and not a mistake: a proposal from an announcement in a course
  -- the user has since removed is still a proposal. It renders unfiled.
  class_id    uuid references classes (id) on delete set null,

  kind        text not null check (kind in ('deadline')),

  -- Where the guess came from, in Google's own ids, so the announcement text
  -- can be shown beside the proposal and so the pair can be deduped.
  --
  -- For an announcement this is `<announcement_id>#<n>`, because one post can
  -- state several deadlines — "essay Friday, presentations the 12th, final
  -- paper on the 30th" is one announcement and three pieces of work. The
  -- ordinal is what gives each its own card, its own accept, and its own
  -- remembered "no"; text rather than a foreign key is precisely what lets a
  -- future source_kind number itself however it needs to.
  source_kind text not null check (source_kind in ('announcement')),
  source_id   text not null,

  payload     jsonb not null,

  -- 'rejected' is kept, never deleted. That row *is* the memory of the answer
  -- — the unique constraint below reads it and the next sync proposes nothing.
  -- Deleting a rejection would ask the same question again every hour.
  status      text not null default 'pending'
                check (status in ('pending', 'accepted', 'rejected')),

  created_at  timestamptz not null default now(),
  decided_at  timestamptz,

  constraint proposals_one_per_source unique (user_id, source_kind, source_id, kind)
);

-- The queue's only query: my pending proposals, newest first.
create index proposals_pending_idx
  on proposals (user_id, created_at desc)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- class_links learns where a link came from, and what is in it
-- ---------------------------------------------------------------------------
--
-- The same table as phase 06's hand-pasted links, not a second one. A
-- syllabus is a syllabus whether you pasted it or your professor attached it,
-- and splitting the two would give the Docs tab two lists to merge, order and
-- de-duplicate on screen.
alter table class_links
  -- Null for every link a person typed. Set to the Drive file id or the URL
  -- of a Classroom attachment, which is what makes ingest idempotent: the
  -- hourly sync sees the same announcement forever and must write it once.
  add column google_material_id  text,
  -- Set only when the attachment is a Drive file, and it is what makes a
  -- summary possible at all: phase 06 wrote that this app never fetches a URL
  -- a user typed, and that still holds. A summary is offered for a document
  -- Google already told us the id of, exported through the user's own grant —
  -- never for an arbitrary link, which would make the server a fetcher of
  -- whatever anyone pasted.
  add column google_drive_id     text,
  add column summary             text,
  add column summary_generated_at timestamptz;

-- Nulls are distinct in Postgres, so this constrains exactly the imported
-- rows and leaves hand-pasted links free to repeat a URL as often as anyone
-- likes — which they may, since the same Drive folder can honestly belong to
-- two classes.
create unique index class_links_material_idx
  on class_links (class_id, google_material_id)
  where google_material_id is not null;

-- ---------------------------------------------------------------------------
-- announcements_seen — server-only, so prose is read once ever
-- ---------------------------------------------------------------------------
--
-- Without this, every hourly cron would re-send every announcement of the
-- term to Gemini: an unbounded bill for an answer that cannot have changed.
-- A row is written whether or not the model found anything, because "nothing
-- here" is a result too and is the far more common one.
--
-- Keyed by Google's announcement id. The body of an announcement can be
-- edited after posting, and this deliberately does not notice — a professor
-- fixing a typo is not a reason to re-run a model, and a professor changing
-- the date posts a new announcement, which has a new id.
create table announcements_seen (
  user_id           uuid not null references users (id) on delete cascade,
  google_course_id  text not null,
  announcement_id   text not null,
  seen_at           timestamptz not null default now(),
  primary key (user_id, announcement_id)
);

-- ---------------------------------------------------------------------------
-- RLS. proposals is the user's, read and written from the browser like every
-- other user-owned table. announcements_seen gets RLS and no policy at all —
-- the same fence as google_tokens in 0001. Only the service role touches it,
-- and nothing on screen has any reason to know it exists.
-- ---------------------------------------------------------------------------

alter table proposals          enable row level security;
alter table announcements_seen enable row level security;

create policy proposals_all_own on proposals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 0006_hours_and_events.sql — the week you actually have, not the one assumed.
--
-- Two changes, one complaint behind both: the planner was working inside hours
-- nobody chose (a hardcoded 8am–10pm) and rendering lectures it did not own,
-- refetched from Google on every open. The first made the plan wrong; the
-- second made the grid arrive late and made a lecture the one thing on screen
-- you could not move.

-- ---------------------------------------------------------------------------
-- plan_blocks gains a third kind: the calendar event
-- ---------------------------------------------------------------------------
--
-- Events were previously fetched on open and drawn straight to the grid,
-- owned by nobody. That was defensible while they were unmovable, and stopped
-- being defensible the moment "I am not going to that lecture" became a thing
-- a person can say. A decision to skip a class is *this* app's fact, not
-- Google's, and it needs a row to live on.
--
-- Google stays the source of truth for when a lecture is: the mirror is
-- refreshed from it, and nothing here is ever written back. What the mirror
-- adds on top is exactly the two columns Google has no opinion about —
-- `dismissed` (I am not attending) and `locked` (I moved this on my board).
alter table plan_blocks
  add column google_event_id text,
  -- Only ever set on an event block. A task block's title is the task's, read
  -- through the join, because a copied title is a title that goes stale.
  add column title text,
  -- Dropped from the board, not deleted. A delete would be undone by the very
  -- next refresh from Google, which is a bug that looks like the app ignoring
  -- you.
  add column dismissed boolean not null default false;

-- Exactly one subject, now of three. An event is not a task and is not a
-- routine; a block that was two of them would have to answer what happens
-- when one of the two is removed.
alter table plan_blocks drop constraint plan_blocks_one_subject;

alter table plan_blocks add constraint plan_blocks_one_subject check (
  (task_id is not null)::int
  + (routine_id is not null)::int
  + (google_event_id is not null)::int = 1
);

-- An event block carries the title it is drawn with; nothing else may.
alter table plan_blocks add constraint plan_blocks_title_only_on_events check (
  title is null or google_event_id is not null
);

-- The refresh is an upsert keyed on this, so a lecture that has been mirrored
-- once is updated rather than duplicated on every open. Per user, because two
-- accounts on one deployment can hold the same Google event id.
create unique index plan_blocks_event_idx
  on plan_blocks (user_id, google_event_id)
  where google_event_id is not null;

-- ---------------------------------------------------------------------------
-- study_windows — the hours you are willing to work in
-- ---------------------------------------------------------------------------
--
-- Replaces DAY_START_HOUR/DAY_END_HOUR, which were a guess the app made about
-- someone else's life and then planned an entire week on top of. A day is not
-- one long window: it is a morning that ends when the classes do, an
-- afternoon, and a late block — with real gaps between them that are not
-- study time and must not be planned into.
--
-- Minutes past local midnight, not `time`, and not an instant. The planner
-- does its arithmetic in minutes-of-day, so storing anything else would mean
-- parsing on every read; and an instant would move a 9pm block when the clocks
-- change, which is the routines bug from 0005 with a different table name.
--
-- `ends_minute` may be 1440. "9pm until midnight" is a real answer and
-- clamping it to 23:59 would silently lose a minute every night.
create table study_windows (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,

  -- Null is every day, matching routines.weekday exactly so the two lists
  -- read the same way. 0–6 is Sunday–Saturday, as Date#getDay.
  weekday       smallint check (weekday is null or weekday between 0 and 6),

  starts_minute integer not null check (starts_minute >= 0 and starts_minute < 1440),
  ends_minute   integer not null check (ends_minute > 0 and ends_minute <= 1440),

  -- Same reason as routines.active: a schedule changes with the term and with
  -- your mood, and re-typing one you already entered is worse than a toggle.
  active        boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint study_windows_ordered check (ends_minute > starts_minute)
);

create index study_windows_user_idx on study_windows (user_id, weekday);

create trigger study_windows_updated_at
  before update on study_windows
  for each row execute function set_updated_at();

alter table study_windows enable row level security;

create policy study_windows_all_own on study_windows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

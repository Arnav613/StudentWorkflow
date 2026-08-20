-- 0009_routine_skips.sql — not going, and how far "not going" reaches.
--
-- 0008 gave a routine three scopes for *moving* one of its blocks. Removing
-- one had only the widest of the three: the whole routine, deleted, from a
-- button on a single Tuesday's card. Skipping one gym session is a far more
-- ordinary thing to want than giving up the gym, and it was the one thing the
-- card could not express.
--
-- The same three scopes as a move, expressed the same way where possible:
--
--   just this once   — a row in routine_skips.
--   every <weekday>  — a routine_overrides row with skipped set.
--   the whole thing  — deleting the routine, which cascades to its blocks.
--
-- A move can use a locked block for its narrow scope because the block still
-- exists to carry the flag. A skip cannot: the block is gone, and something
-- has to remember that it should stay gone the next time the week is planned.

-- ---------------------------------------------------------------------------
-- routine_overrides can now say "not on this day" as well as "at this time"
-- ---------------------------------------------------------------------------

alter table routine_overrides
  add column skipped boolean not null default false;

-- A skip carries no time, so the column stops being mandatory. The check keeps
-- the two states honest: an override either moves the day or cancels it, and a
-- row that did neither would be an exception to nothing.
alter table routine_overrides
  alter column time_of_day drop not null;

alter table routine_overrides
  add constraint routine_overrides_says_something
    check (skipped or time_of_day is not null);

-- ---------------------------------------------------------------------------
-- routine_skips — one occurrence, not happening
-- ---------------------------------------------------------------------------
--
-- A local calendar date, not a timestamptz. "I am not going on the 24th" is a
-- statement about a day in the city you are standing in, and storing it as an
-- instant would move it across a midnight for anyone who travels.
create table routine_skips (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  routine_id uuid not null references routines (id) on delete cascade,

  on_date    date not null,

  created_at timestamptz not null default now(),

  constraint routine_skips_one_per_day unique (routine_id, on_date)
);

create index routine_skips_user_idx on routine_skips (user_id, on_date);

alter table routine_skips enable row level security;

create policy routine_skips_all_own on routine_skips
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 0012_planner_agent.sql — Phase 13. Two facts the week had no field for.
--
-- PLAN.md called this file 0008 and named one table. The number moved because
-- phases 07–10 wrote five migrations in between; the shape moved because the
-- planner turned out to be missing two things rather than one.
--
--   **A blackout** is an hour that is neither work nor routine. "Out on
--   Wednesday afternoon" is not a weekly rehearsal and is not a task, and
--   forcing it into either table would make one of them lie — routines would
--   gain a table full of things that happen once, or the board would gain
--   cards nobody can tick off. It is its own row, and it merges into the
--   `busy` list `planWeek` already takes, so the scheduler gains no argument
--   and no branch.
--
--   **A skip** is "not this week". The agent is allowed to say the reading can
--   wait, and there was no honest way to write that down: moving `due_at`
--   would be the model editing a deadline, which is the one thing phase 09
--   forbade, and deleting the task would lose it. `plan_skip_until` says only
--   what it means — the planner may not spend hours on this before that date.
--   The board still shows the real due date, in red if that is the truth.
--
-- Neither table stores a conversation, and there is no proposals row here.
-- What the agent suggests lives in React state until it is accepted, and what
-- lands is these two columns and the ordinary tasks the ordinary planner then
-- plans. See PLAN.md, phase 13.

-- ---------------------------------------------------------------------------
-- blackouts — one-off hours that are gone
-- ---------------------------------------------------------------------------
--
-- timestamptz, not a date and a time-of-day. Unlike a routine, a blackout is
-- a specific interval on a specific day; it never repeats, so it never needs
-- the weekday/time-of-day pair that lets routines be generated.
create table blackouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,

  starts_at  timestamptz not null,
  ends_at    timestamptz not null,

  -- Optional, and shown on the grid when it is there. "Out" is a perfectly
  -- good blackout; "Dentist" is a better one, and the difference matters a
  -- week later when you are deciding whether it can move.
  reason     text,

  created_at timestamptz not null default now(),

  constraint blackouts_end_after_start check (ends_at > starts_at)
);

create index blackouts_user_idx on blackouts (user_id, starts_at);

alter table blackouts enable row level security;

create policy blackouts_all_own on blackouts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- tasks.plan_skip_until — not this week, without touching the deadline
-- ---------------------------------------------------------------------------
--
-- A local date, for the reason routine_skips.on_date is one: "leave it until
-- Monday" is a statement about a day where you are standing, not an instant.
--
-- Null is the normal state and means nothing is deferred. A date in the past
-- is equivalent — the planner compares against today, so a skip expires on
-- its own and nothing has to sweep the column. That is deliberate: a deferral
-- that needed clearing would eventually be a task nobody could explain.
alter table tasks
  add column plan_skip_until date;

-- 0005_planning.sql — Phase 07. Estimates, routines, and the week plan.
--
-- Three additions, one idea: the board says *what* is due, and none of it says
-- *when you will do it*. A deadline is a constraint; a plan is a decision. The
-- rows below are where those decisions live.
--
-- Deliberately absent: any notion of "priority". How long a thing takes is a
-- fact you can estimate and check yourself against later; how much it matters
-- is a feeling that changes hourly, and a field for it would only ever be a
-- second, worse due date.

-- ---------------------------------------------------------------------------
-- tasks.estimate_minutes
-- ---------------------------------------------------------------------------
--
-- Nullable, and null means *unestimated* — never zero. The scheduler has to
-- tell "I have not said" from "this takes no time", because the first gets a
-- class-median guess shown in italics and the second would silently occupy no
-- space in the week and then take an afternoon.
--
-- Capped at a working day. An estimate above that is a project, not a task,
-- and the honest response is to split it rather than to let the planner carve
-- a sixteen-hour block out of a Tuesday.
alter table tasks
  add column estimate_minutes integer
    check (estimate_minutes is null or (estimate_minutes > 0 and estimate_minutes <= 960));

-- ---------------------------------------------------------------------------
-- routines — the things that occupy time but are not work
-- ---------------------------------------------------------------------------
--
-- Gym, laundry, a standing rehearsal. These are deliberately *not* tasks:
-- they never enter the board, never archive, never complete and never have a
-- due date. Modelling them as recurring tasks would spawn a card every week
-- that you either tick forever or learn to ignore — and a board you have
-- learned to ignore is the failure this app exists to prevent.
--
-- What they do is occupy hours, which is the only thing the planner needs
-- from them.
create table routines (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,

  title            text not null check (length(trim(title)) > 0 and length(title) <= 120),

  -- Null means daily; 0–6 is Sunday–Saturday, matching JS getDay() so the
  -- frontend never has to shift an index and get it wrong on one of them.
  weekday          smallint check (weekday is null or weekday between 0 and 6),

  -- Wall-clock local time, not a timestamptz. A 7am gym slot is 7am in
  -- whatever city you are in; storing it as an instant would move it when the
  -- clocks change and make it a different appointment.
  time_of_day      time not null,
  duration_minutes integer not null check (duration_minutes > 0 and duration_minutes <= 960),

  -- Kept rather than deleted when it lapses. A term's routine comes back next
  -- term, and re-typing it is worse than a toggle.
  active           boolean not null default true,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index routines_user_idx on routines (user_id, active);

create trigger routines_updated_at
  before update on routines
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- plan_blocks — an hour of the week, spoken for
-- ---------------------------------------------------------------------------
--
-- Exactly one of task_id or routine_id. A block is either "work on this" or
-- "this hour is already gone"; a block that is both would have to answer what
-- happens when the task is deleted, and there is no good answer.
--
-- `locked` is the entire manual-edit story. Regeneration deletes and rewrites
-- unlocked blocks and routes *around* locked ones — so dragging a block to
-- Thursday evening is a decision the planner then has to plan around, not a
-- suggestion it overwrites the next time you press the button. Nothing sets
-- locked except a human moving or retyping a block.
create table plan_blocks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,

  task_id     uuid references tasks (id) on delete cascade,
  routine_id  uuid references routines (id) on delete cascade,

  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  locked      boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint plan_blocks_one_subject check (
    (task_id is not null) <> (routine_id is not null)
  ),
  -- A zero-length block is not a session, and a negative one is a bug that
  -- would render as a block growing backwards out of its column.
  constraint plan_blocks_ordered check (ends_at > starts_at)
);

-- The week query is "everything from this instant forward", so the index
-- leads on time within a user.
create index plan_blocks_user_time_idx on plan_blocks (user_id, starts_at);
create index plan_blocks_task_idx on plan_blocks (task_id);

create trigger plan_blocks_updated_at
  before update on plan_blocks
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Owner-only, one `for all` policy each, as every user-owned table since
-- migration 0001.
-- ---------------------------------------------------------------------------

alter table routines enable row level security;

create policy routines_all_own on routines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table plan_blocks enable row level security;

create policy plan_blocks_all_own on plan_blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

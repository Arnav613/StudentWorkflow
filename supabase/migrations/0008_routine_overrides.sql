-- 0008_routine_overrides.sql — one Tuesday that runs late.
--
-- A routine says "gym, every day, five o'clock". The thing a routine could not
-- say is the ordinary case: this week I am going at six on Tuesdays, and next
-- Tuesday too, but five is still right for the rest of it.
--
-- Before this there were two answers and both were wrong. Edit the routine and
-- every day moves. Do not edit it and the plan is a lie every Tuesday until
-- you fix it by hand, forever.
--
-- Three scopes, and this table is the middle one:
--
--   just this once   — the block is locked. That is already what locked means
--                      everywhere else in the app: a person put this here, and
--                      the planner routes around it rather than rewriting it.
--                      It needs no row, and a row would outlive the day it
--                      described.
--   every <weekday>  — one row here.
--   the whole thing  — routines.time_of_day, and these rows are cleared,
--                      because a rule restated for every day has nothing left
--                      to make an exception to.
create table routine_overrides (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  routine_id  uuid not null references routines (id) on delete cascade,

  -- Not nullable, unlike routines.weekday. A null there means "every day",
  -- which is the routine's own job to say; an override that applied to every
  -- day would simply be the routine with extra steps.
  weekday     smallint not null check (weekday between 0 and 6),

  time_of_day time not null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One rule per weekday per routine. Two would be a coin toss over which
  -- time Tuesday gets.
  constraint routine_overrides_one_per_day unique (routine_id, weekday)
);

create index routine_overrides_user_idx on routine_overrides (user_id);

create trigger routine_overrides_updated_at
  before update on routine_overrides
  for each row execute function set_updated_at();

alter table routine_overrides enable row level security;

create policy routine_overrides_all_own on routine_overrides
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

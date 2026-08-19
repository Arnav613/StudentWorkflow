-- 0002_dismissed_courses.sql
--
-- Removing a class now means removing it, not shelving it.
--
-- Phase 01 modelled "I am not taking this any more" as hidden = true, which
-- kept the row and its tasks around forever. In practice a stale course is
-- noise the user wants gone: its deadlines are dead, and the only reason it
-- appeared is that a professor forgot to archive it.
--
-- Two things have to change together for a delete to actually stick:
--   1. Tasks follow their class out the door, rather than being orphaned.
--   2. The Classroom link is remembered as *refused*, or the next sync would
--      cheerfully import the whole course again a minute later.

-- ---------------------------------------------------------------------------
-- 1. Deleting a class deletes its tasks.
--
-- Was `on delete set null`, which kept the tasks and detached them. That is
-- the right behaviour for a class you are tidying up and the wrong one for a
-- class you are throwing away — the tasks are exactly what you wanted gone.
--
-- Note this takes hand-made tasks with it too, if they were filed under the
-- class. A task with no class (`class_id is null`) is untouched.
-- ---------------------------------------------------------------------------

alter table tasks drop constraint tasks_class_id_fkey;

alter table tasks
  add constraint tasks_class_id_fkey
  foreign key (class_id) references classes (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 2. dismissed_courses — the tombstones sync consults before importing.
--
-- Keyed by Google's course id rather than by name: the name is what the user
-- sees and may edit, the id is what identifies the course to Classroom.
-- `name` is carried along only so the "you dismissed these" list can be read
-- by a human without a round trip to Google.
-- ---------------------------------------------------------------------------

create table dismissed_courses (
  user_id           uuid not null references users (id) on delete cascade,
  google_course_id  text not null,
  name              text,
  dismissed_at      timestamptz not null default now(),
  primary key (user_id, google_course_id)
);

alter table dismissed_courses enable row level security;

create policy dismissed_courses_all_own on dismissed_courses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Existing hidden classes were the user saying "get rid of this" with the
--    only verb the app offered. Honour it retroactively.
--
--    Linked ones become tombstones so they stay gone. Hand-made hidden classes
--    have nothing to tombstone — there is no course to refuse — so they are
--    simply deleted, and their tasks with them.
-- ---------------------------------------------------------------------------

insert into dismissed_courses (user_id, google_course_id, name)
select user_id, google_course_id, name
from classes
where hidden = true
  and google_course_id is not null
on conflict (user_id, google_course_id) do nothing;

delete from classes where hidden = true;

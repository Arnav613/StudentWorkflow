-- 0004_class_links.sql — Phase 06. The Docs tab inside a class.
--
-- Links, not files. A syllabus, a Drive folder, a reading list, the course
-- page — the things a student actually needs to reach from a class are
-- already URLs somewhere else, and re-hosting copies of them would buy a
-- storage bucket, an upload UI, a size limit to police and a second copy to
-- go stale, in exchange for nothing the link did not already do.
--
-- Deliberately absent: any attempt to fetch, preview or validate the target.
-- A link is a string the user typed. Rendering it as anything more would mean
-- this app makes outbound requests on their behalf to arbitrary URLs.

create table class_links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  -- Cascades with the class, like notes. A link to a course page outlives
  -- neither the course nor the student's interest in it.
  class_id    uuid not null references classes (id) on delete cascade,

  title       text not null default '' check (length(title) <= 200),
  url         text not null check (length(trim(url)) > 0 and length(url) <= 2000),

  -- Hand-ordered. Docs are a short list a person curates, not a feed: the
  -- syllabus belongs at the top because they put it there, not because of
  -- when they added it.
  position    integer not null default 0,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index class_links_class_idx on class_links (class_id, position);

create trigger class_links_updated_at
  before update on class_links
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Owner-only, keyed on auth.uid() — the same single `for all` policy
-- every other user-owned table in migration 0001 uses.
-- ---------------------------------------------------------------------------

alter table class_links enable row level security;

create policy class_links_all_own on class_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

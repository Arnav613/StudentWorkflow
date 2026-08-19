-- 0001_init.sql — Ashoka Student Dashboard, initial schema.
--
-- Every table carries user_id and has row-level security enabled in this same
-- migration. RLS is not retrofitted; a table without a policy is a table that
-- leaks the moment the anon key reaches a browser.
--
-- Columns marked CLASSROOM are unused until phase 05. They exist now because
-- backfilling a discriminator across live user data is worse than a nullable
-- column that sits empty for a few months.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type task_status as enum ('todo', 'doing', 'done');
create type task_source as enum ('manual', 'classroom');

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users — a public mirror of auth.users we are allowed to join against.
-- ---------------------------------------------------------------------------

create table users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- Populated by trigger rather than by the app, so a user row always exists by
-- the time the first authenticated request arrives.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email      = excluded.email,
        full_name  = coalesce(excluded.full_name, public.users.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.users.avatar_url);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- classes
-- ---------------------------------------------------------------------------

create table classes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  color       text not null default 'slate',
  professor   text,
  meeting_info text,
  hidden      boolean not null default false,

  -- CLASSROOM. Null for every hand-made class. Set when linked or imported.
  google_course_id text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One Classroom course maps to at most one class per user. Partial, so the
-- many null rows of a manual-only world do not collide.
create unique index classes_user_google_course_idx
  on classes (user_id, google_course_id)
  where google_course_id is not null;

create index classes_user_idx on classes (user_id) where hidden = false;

create trigger classes_updated_at
  before update on classes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

create table tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,

  -- Nullable on purpose: laundry and club meetings are not coursework, and a
  -- Miscellaneous class is a worse answer than a null.
  class_id    uuid references classes (id) on delete set null,

  title       text not null check (length(trim(title)) > 0),
  description text,
  due_at      timestamptz,

  status      task_status not null default 'todo',
  source      task_source not null default 'manual',

  -- Ordering within a column for drag and drop. Sort is due_at first; this
  -- only breaks ties and holds hand-dragged order among undated tasks.
  position    double precision not null default 0,

  completed_at timestamptz,
  archived_at  timestamptz,

  -- CLASSROOM, all four.
  google_coursework_id text,
  google_course_id     text,
  -- True once the user drags a card away from where a sync put it. Sync must
  -- not fight the user: this is the flag that makes the drag-back stick.
  status_overridden    boolean not null default false,
  auto_completed       boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index tasks_user_google_coursework_idx
  on tasks (user_id, google_coursework_id)
  where google_coursework_id is not null;

-- The board query: everything not yet archived, for one user.
create index tasks_board_idx
  on tasks (user_id, status, due_at)
  where archived_at is null;

create index tasks_class_idx on tasks (class_id) where archived_at is null;

create trigger tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

-- completed_at should track status without the app having to remember.
create or replace function sync_task_completed_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'done' and (old.status is distinct from 'done') then
    new.completed_at = now();
  elsif new.status <> 'done' then
    new.completed_at = null;
    new.archived_at = null;
  end if;
  return new;
end;
$$;

create trigger tasks_completed_at
  before insert or update of status on tasks
  for each row execute function sync_task_completed_at();

-- ---------------------------------------------------------------------------
-- checklist_items — always hand-added, never generated.
-- ---------------------------------------------------------------------------

create table checklist_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  task_id     uuid not null references tasks (id) on delete cascade,
  label       text not null check (length(trim(label)) > 0),
  done        boolean not null default false,
  position    double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index checklist_items_task_idx on checklist_items (task_id, position);

create trigger checklist_items_updated_at
  before update on checklist_items
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- notes — one notebook per class, many notes inside it.
-- Notes attach to a class, never to an individual task.
-- ---------------------------------------------------------------------------

create table notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  class_id    uuid not null references classes (id) on delete cascade,
  title       text not null default 'Untitled',
  -- BlockNote document. jsonb, not text: the editor round-trips a block tree.
  content     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index notes_class_idx on notes (class_id, updated_at desc);

create trigger notes_updated_at
  before update on notes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- google_tokens — CLASSROOM. Empty until phase 05.
--
-- The refresh token is encrypted by the backend before it ever arrives here;
-- this table stores ciphertext and never sees the plaintext. No policy grants
-- the client access to this table at all — service role only.
-- ---------------------------------------------------------------------------

create table google_tokens (
  user_id             uuid primary key references users (id) on delete cascade,
  refresh_token_enc   text not null,
  scopes              text[] not null default '{}',
  connected_at        timestamptz not null default now(),
  last_refreshed_at   timestamptz,
  -- Set when Google rejects the refresh token. In Testing mode this happens
  -- every seven days, and it is what raises the reconnect banner.
  needs_reconnect     boolean not null default false,
  updated_at          timestamptz not null default now()
);

create trigger google_tokens_updated_at
  before update on google_tokens
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sync_state — CLASSROOM. Empty until phase 05.
-- ---------------------------------------------------------------------------

create table sync_state (
  user_id           uuid primary key references users (id) on delete cascade,
  last_sync_at      timestamptz,
  last_success_at   timestamptz,
  last_error        text,
  courses_synced    integer not null default 0,
  tasks_synced      integer not null default 0,
  updated_at        timestamptz not null default now()
);

create trigger sync_state_updated_at
  before update on sync_state
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Enabled on every table. Owner-only, keyed on auth.uid(). The service role
-- bypasses RLS entirely, which is how the backend sync job will write rows.
-- ---------------------------------------------------------------------------

alter table users           enable row level security;
alter table classes         enable row level security;
alter table tasks           enable row level security;
alter table checklist_items enable row level security;
alter table notes           enable row level security;
alter table google_tokens   enable row level security;
alter table sync_state      enable row level security;

-- users: readable and updatable by self. No insert policy — the auth trigger
-- creates the row, and nothing else should.
create policy users_select_own on users
  for select using (auth.uid() = id);
create policy users_update_own on users
  for update using (auth.uid() = id) with check (auth.uid() = id);

create policy classes_all_own on classes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy tasks_all_own on tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy checklist_items_all_own on checklist_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy notes_all_own on notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- google_tokens and sync_state get NO policies. RLS is on, so with no policy
-- every client request returns nothing. Only the service role touches these.

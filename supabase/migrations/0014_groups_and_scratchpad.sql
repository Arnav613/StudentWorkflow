-- ---------------------------------------------------------------------------
-- 0014 — grouping on the board, and a scratchpad that is not a task list.
--
-- Two additions, both of them about the same thing: the app currently has
-- exactly one shape for "something I have to hold in my head", and a task is
-- too heavy for half of what a term throws at you.
--
-- A group is a label, not a task. It has no due date, no estimate and no
-- hours, and the planner never sees it — which is the entire reason it is a
-- separate table rather than a self-reference on `tasks`. A parent row inside
-- `tasks` would be picked up by the Unplanned rail, counted by the class
-- health cards and offered an hour by Autoplan, and every one of those would
-- have to be taught to skip it. Nothing has to be taught to skip a table it
-- does not query.
--
-- A scratch line is one line of the notes page. Stored as rows rather than as
-- one text column because each line can carry a marker — a class, or a task it
-- was turned into — and a marker attached to an offset into a blob is a
-- marker that moves the moment you type above it.
-- ---------------------------------------------------------------------------

create table task_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,

  title       text not null check (length(trim(title)) > 0 and length(title) <= 120),

  -- Sort key, not an index. Same convention as tasks.position.
  position    double precision not null default 0,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index task_groups_user_idx on task_groups (user_id, position);

create trigger task_groups_updated_at
  before update on task_groups
  for each row execute function set_updated_at();

-- `set null`, never cascade. Deleting a group ungroups its tasks and leaves
-- them on the board: a label coming off eleven readings must not be a way to
-- delete eleven readings, and the undo for the second one is a support ticket.
alter table tasks
  add column group_id uuid references task_groups (id) on delete set null;

create index tasks_group_idx on tasks (group_id) where group_id is not null;

-- ---------------------------------------------------------------------------

create table scratch_lines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,

  -- Empty is legal and ordinary: a blank line is how a person spaces a page,
  -- and refusing to store one would make the cursor jump on every Enter.
  text        text not null default '' check (length(text) <= 2000),

  -- The two markers. Both optional, both independent — a line can be about a
  -- class, or be a task now, or both, or neither.
  class_id    uuid references classes (id) on delete set null,
  task_id     uuid references tasks (id) on delete set null,

  position    double precision not null default 0,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index scratch_lines_user_idx on scratch_lines (user_id, position);

create trigger scratch_lines_updated_at
  before update on scratch_lines
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Owner-only, one `for all` policy each, as every user-owned table since
-- migration 0001.
-- ---------------------------------------------------------------------------

alter table task_groups enable row level security;

create policy task_groups_all_own on task_groups
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table scratch_lines enable row level security;

create policy scratch_lines_all_own on scratch_lines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

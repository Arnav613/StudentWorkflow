-- ---------------------------------------------------------------------------
-- The board stops sorting itself
-- ---------------------------------------------------------------------------
-- Until now a column was sorted for you: overdue first, then by due date, then
-- undated, with `position` used only as a tie-break among the undated. That is
-- a good default and a bad ceiling — the order you actually work in is not the
-- order the deadlines happen to fall in, and there was no way to say so.
--
-- From here `position` is the whole answer. A column is the order you put it
-- in, and nothing on the board rearranges itself behind your back.
--
-- Which leaves every existing row sharing the default of 0, and a column of
-- ties is a column with no order at all. So this backfills once, per user and
-- per column, using exactly the sort the app was showing a moment before the
-- deploy — so the first board anyone opens afterwards looks identical to the
-- last one they closed, and only moves when they move it.
--
-- Archived rows are left alone: they are off the board, they are read in
-- completion order, and numbering them would be work nobody can see.
-- ---------------------------------------------------------------------------

with ordered as (
  select
    id,
    row_number() over (
      partition by user_id, status
      order by
        -- Overdue first. Booleans sort false before true, so `desc` puts the
        -- late work at the top, which is where it was yesterday.
        (status <> 'done' and due_at is not null and due_at < now()) desc,
        -- Then dated before undated: "sometime" never outranked "tomorrow".
        (due_at is null) asc,
        due_at asc,
        position asc,
        created_at asc
    ) as rn
  from tasks
  where archived_at is null
)
update tasks t
   set position = o.rn
  from ordered o
 where o.id = t.id;

-- Groups no longer carry an order of their own. A group is drawn at the
-- position of its first card, and dragging the header renumbers the cards
-- underneath it — one sort key for the whole column instead of two that can
-- disagree. The column stays for the rows already written into it.
comment on column task_groups.position is
  'Creation order only. A group renders at the position of its first task; see lib/board.ts.';

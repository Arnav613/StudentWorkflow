-- 0015_push_subscriptions.sql — the morning digest.
--
-- One row per *device*, not per user. A push subscription belongs to a
-- browser profile on a phone, so the same person with the app on a phone and
-- pinned in a laptop browser holds two, and both should ring.
--
-- Server-only, following google_tokens exactly: RLS on, no policy, service
-- role only. Two reasons, and the second is the load-bearing one.
--
--   The endpoint URL is a bearer capability. Anyone holding it can push a
--   notification to that device without any further credential — the whole
--   protocol is "POST to this URL, encrypted to these keys". It is not a
--   secret in the way a password is, but it is not a row to hand the anon key
--   read access to either.
--
--   More practically: the digest job runs from cron with no session. It has
--   to read every user's subscriptions at once, which no RLS policy written
--   in terms of auth.uid() can express. The backend was always going to be
--   the only reader.
--
-- So the browser reaches this table through POST /push/subscribe rather than
-- through PostgREST — the one place in the app where a write goes to Render
-- instead of straight to Supabase. That is a deliberate exception to the
-- top-of-PLAN.md rule, and it is narrow: subscribing is not an ordinary
-- interaction, it happens once per device, and it is already behind a
-- permission prompt that costs a user gesture. Nothing on the critical path
-- of using the app waits on a cold dyno because of this table.

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,

  -- The push service's URL for this device. Unique globally rather than per
  -- user: the same endpoint cannot belong to two accounts, and if a shared
  -- phone signs out and in as someone else the browser reuses it. Uniqueness
  -- here means the upsert in POST /push/subscribe re-points the row at the
  -- new owner instead of quietly delivering one person's deadlines to
  -- another's lock screen.
  endpoint    text not null unique,

  -- The device's public key and auth secret, base64url as the browser gives
  -- them. Together with the VAPID private key on the server these encrypt the
  -- payload; the push service relays ciphertext it cannot read.
  p256dh      text not null,
  auth        text not null,

  -- What the user agreed to. One flag today, and a table rather than a column
  -- on `users` partly so the second reminder kind is a column here, not a
  -- migration that has to invent per-device state from scratch.
  digest      boolean not null default true,

  -- Set from the browser at subscribe time. The digest is "what is due today"
  -- and today starts at midnight wherever the phone is — a student on a
  -- semester abroad should not get Delhi's Tuesday. Defaulted, not required,
  -- because every browser that can subscribe can also report this.
  timezone    text not null default 'Asia/Kolkata',

  -- Diagnostics for the failure that actually happens: subscriptions expire
  -- silently and the push service starts answering 410. `last_error` is what
  -- turns "no notifications this week" from a mystery into a sentence.
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error   text,
  updated_at   timestamptz not null default now()
);

-- The digest job's only query: every subscription that wants one. Small table,
-- but this is a full scan every morning otherwise, and it costs one index.
create index push_subscriptions_digest_idx
  on push_subscriptions (user_id)
  where digest;

create trigger push_subscriptions_updated_at
  before update on push_subscriptions
  for each row execute function set_updated_at();

-- RLS on, no policy: with none, every request carrying an anon or
-- authenticated key returns nothing at all. The service role bypasses it.
-- See the note above 'google_tokens' in 0001.
alter table push_subscriptions enable row level security;

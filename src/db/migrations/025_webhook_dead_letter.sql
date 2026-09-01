-- When processing a single webhook change throws, the raw payload is parked
-- here with the error instead of being lost. A human (or a future replay job)
-- can inspect and re-run it, so a bad deploy or a transient DB error never
-- silently drops a lead's message.
create table if not exists webhook_dead_letter (
  id bigserial primary key,
  payload jsonb not null,
  error text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhook_dead_letter_unresolved
  on webhook_dead_letter (created_at desc) where resolved_at is null;

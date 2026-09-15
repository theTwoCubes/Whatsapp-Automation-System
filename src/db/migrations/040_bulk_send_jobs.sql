create table if not exists bulk_send_jobs (
  id bigserial primary key,
  batch_id uuid not null,
  wa_id text not null,
  name text,
  business text,
  email text,
  topic_id bigint references topics(id) on delete set null,
  template_name text not null,
  status text not null default 'pending', -- pending | sending | sent | failed | stuck | skipped
  error text,
  conversation_id bigint references conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bulk_send_due on bulk_send_jobs (status, id);
create index if not exists idx_bulk_send_batch on bulk_send_jobs (batch_id);

create table if not exists templates (
  id bigserial primary key,
  name text not null unique,
  language text not null default 'en',
  category text,
  body text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists drip_jobs (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id),
  step int not null,
  template_name text not null,
  run_at timestamptz not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_drip_due on drip_jobs (status, run_at);
create unique index if not exists uniq_drip_pending_step on drip_jobs (conversation_id, step) where status = 'pending';

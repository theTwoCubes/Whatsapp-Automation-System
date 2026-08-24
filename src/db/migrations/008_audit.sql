create table if not exists audit_log (
  id bigserial primary key,
  actor text,
  action text not null,
  target text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_created on audit_log (created_at desc);

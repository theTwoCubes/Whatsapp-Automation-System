create table if not exists settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

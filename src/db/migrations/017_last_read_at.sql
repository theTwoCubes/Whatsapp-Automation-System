alter table conversations add column last_read_at timestamptz not null default now();

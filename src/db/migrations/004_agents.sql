create table if not exists agents (
  id bigserial primary key,
  email text not null unique,
  name text,
  password_hash text not null,
  created_at timestamptz not null default now()
);

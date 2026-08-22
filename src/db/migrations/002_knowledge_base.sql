create table if not exists knowledge_base (
  id bigserial primary key,
  title text not null,
  content text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

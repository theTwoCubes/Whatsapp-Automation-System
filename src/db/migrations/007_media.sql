create table if not exists media_assets (
  id bigserial primary key,
  meta_media_id text,
  filename text,
  mime_type text,
  kind text not null,
  caption text,
  created_at timestamptz not null default now()
);

-- Hosted links: external URLs (Google Drive, S3, YouTube, portfolio pages) the
-- AI can share when a customer asks for something too large or too dynamic to
-- fit in the media library. Same shape as payment_links: tagged to a topic
-- with a description, the AI picks one by id from a shown catalog.
create table if not exists hosted_links (
  id bigserial primary key,
  topic_id bigint references topics(id) on delete cascade,
  label text not null,
  url text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hosted_links_topic on hosted_links (topic_id) where active = true;

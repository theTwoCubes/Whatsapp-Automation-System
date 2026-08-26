-- The knowledge foundation. Adds pgvector, a topics table, and extends the
-- existing knowledge_base into a tiered store with embeddings, provenance and
-- full text search. Existing rows are treated as base scope with manual source.

create extension if not exists vector;

create table if not exists topics (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table knowledge_base add column if not exists scope text not null default 'base';
alter table knowledge_base add column if not exists topic_id bigint references topics(id) on delete cascade;
alter table knowledge_base add column if not exists source text not null default 'manual';
alter table knowledge_base add column if not exists embedding vector(1536);
alter table knowledge_base add column if not exists tsv tsvector;
alter table knowledge_base add column if not exists updated_at timestamptz not null default now();

-- Keep the full text search column in sync automatically and refresh
-- updated_at on every write.
create or replace function knowledge_base_tsv_refresh() returns trigger as $$
begin
  new.tsv := to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.content, ''));
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists knowledge_base_tsv_trigger on knowledge_base;
create trigger knowledge_base_tsv_trigger
  before insert or update on knowledge_base
  for each row execute function knowledge_base_tsv_refresh();

-- Backfill the tsv for existing rows by touching them.
update knowledge_base set title = title;

-- HNSW for vector similarity, GIN for full text, plus a filter index to keep
-- the retrieval query narrow.
create index if not exists knowledge_base_embedding_hnsw
  on knowledge_base using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_base_tsv_gin
  on knowledge_base using gin (tsv);
create index if not exists knowledge_base_scope_topic
  on knowledge_base (scope, topic_id) where active = true;

-- Link ad campaigns to a topic so a lead's campaign biases retrieval.
alter table campaigns add column if not exists topic_id bigint references topics(id);

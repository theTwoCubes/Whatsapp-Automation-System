-- Payment links, one per topic per purpose (e.g. an analysis fee and a
-- project deposit for the same service). Modelled on media_assets: the AI is
-- given a catalog with a description and picks one by id, same guardrail as
-- send_media_id so it can never invent a link.
create table if not exists payment_links (
  id bigserial primary key,
  topic_id bigint references topics(id) on delete cascade,
  label text not null,
  amount_inr integer,
  url text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_links_topic on payment_links (topic_id) where active = true;

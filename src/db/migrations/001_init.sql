create table if not exists campaigns (
  id bigserial primary key,
  source_id text not null unique,
  source_type text,
  source_url text,
  headline text,
  body text,
  created_at timestamptz not null default now()
);

create table if not exists contacts (
  id bigserial primary key,
  wa_id text not null unique,
  name text,
  first_campaign_id bigint references campaigns(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists conversations (
  id bigserial primary key,
  contact_id bigint not null unique references contacts(id),
  state text not null default 'bot',
  assignee text,
  campaign_id bigint references campaigns(id),
  window_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id),
  wa_message_id text unique,
  direction text not null,
  type text not null default 'text',
  body text,
  status text,
  referral_campaign_id bigint references campaigns(id),
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_conversation on messages (conversation_id, created_at);

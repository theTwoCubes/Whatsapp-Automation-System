-- Freeform labels an agent can put on a conversation (won, lost, spam,
-- follow-up-later, whatever the team actually uses) - a lighter, more
-- flexible signal than the bot/pending/human state, and filterable in the
-- console conversation list.
create table if not exists tags (
  id bigserial primary key,
  name text not null unique,
  color text not null default '#6b7280',
  created_at timestamptz not null default now()
);

create table if not exists conversation_tags (
  conversation_id bigint not null references conversations(id) on delete cascade,
  tag_id bigint not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);

create index if not exists idx_conversation_tags_tag on conversation_tags (tag_id);

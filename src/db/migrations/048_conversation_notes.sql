-- Internal, agent-only notes on a conversation. Never sent to the lead,
-- never shown outside the console - just context one teammate leaves for
-- another (or themselves) about a chat.
create table if not exists conversation_notes (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  agent_email text not null,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_notes_conversation
  on conversation_notes (conversation_id, created_at desc);

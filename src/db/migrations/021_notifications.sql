-- An in-app notification inbox, so the bell finally means something.
-- Every push we fan out also lands here, per subscribed agent, so the drawer
-- can list what the app has tried to alert them about with unread state,
-- click-through to the chat, and mark-all-read.
create table if not exists notifications (
  id bigserial primary key,
  agent_email text not null,
  kind text not null,
  conversation_id bigint references conversations(id) on delete cascade,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_agent
  on notifications (agent_email, created_at desc);

create index if not exists idx_notifications_agent_unread
  on notifications (agent_email, created_at desc) where read_at is null;

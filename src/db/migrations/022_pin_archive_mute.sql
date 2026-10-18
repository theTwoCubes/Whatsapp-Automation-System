-- Pin, archive, and mute for conversations. All three are global (not
-- per-agent) since this runs as a shared inbox. If per-agent state is ever
-- needed, a companion table keyed on (agent_email, conversation_id) can
-- override these without touching this schema.
alter table conversations add column if not exists pinned_at timestamptz;
alter table conversations add column if not exists archived_at timestamptz;
alter table conversations add column if not exists muted_until timestamptz;

create index if not exists idx_conversations_pinned on conversations (pinned_at desc) where pinned_at is not null;
create index if not exists idx_conversations_archived on conversations (archived_at) where archived_at is not null;

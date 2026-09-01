-- Block and soft-delete for conversations.
-- blocked_at: the lead is blocked at WhatsApp; the bot ignores their inbound.
-- deleted_at: soft delete, hidden everywhere; a nightly job hard-deletes rows
-- past 30 days so an accidental delete can be undone in the meantime.
alter table conversations add column if not exists blocked_at timestamptz;
alter table conversations add column if not exists deleted_at timestamptz;

create index if not exists idx_conversations_deleted on conversations (deleted_at) where deleted_at is not null;
create index if not exists idx_conversations_blocked on conversations (blocked_at) where blocked_at is not null;

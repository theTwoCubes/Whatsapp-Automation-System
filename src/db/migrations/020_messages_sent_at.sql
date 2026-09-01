-- The lead's send time from the WhatsApp payload, distinct from created_at
-- which is when we wrote the row. If the server was offline for hours, the
-- webhook retry lands late and created_at is misleading; sent_at is the truth.
alter table messages add column if not exists sent_at timestamptz;

-- Fallback for old rows: seed sent_at from created_at so ordering by sent_at
-- still works everywhere without a null-coalesce.
update messages set sent_at = created_at where sent_at is null;

create index if not exists idx_messages_conversation_sent_at on messages (conversation_id, sent_at);

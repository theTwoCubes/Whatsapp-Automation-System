-- Integrity guardrails so a bad write is rejected by the schema instead of
-- quietly corrupting state. Added NOT VALID first (cheap, no full-table lock)
-- then validated, which only reads existing rows. All current data already
-- satisfies these: direction is inbound/outbound and state is bot/human/pending
-- everywhere in the code.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_direction_chk') then
    alter table messages
      add constraint messages_direction_chk check (direction in ('inbound', 'outbound')) not valid;
    alter table messages validate constraint messages_direction_chk;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'conversations_state_chk') then
    alter table conversations
      add constraint conversations_state_chk check (state in ('bot', 'human', 'pending')) not valid;
    alter table conversations validate constraint conversations_state_chk;
  end if;
end $$;

-- Hot-path indexes. sent_at ordering is what the thread and list now use.
create index if not exists idx_messages_conversation_sent on messages (conversation_id, sent_at, id);

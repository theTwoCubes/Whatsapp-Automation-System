-- Reverts 043_rejected_state.sql. Rejecting a pending handoff turned out to
-- need the rejecting agent to take the chat themselves, not a separate silent
-- state - any row that ended up 'rejected' before this ships becomes 'human'
-- with no assignee, same as any other unclaimed human-owned chat.
update conversations set state = 'human' where state = 'rejected';

alter table conversations drop constraint if exists conversations_state_chk;
alter table conversations
  add constraint conversations_state_chk check (state in ('bot', 'human', 'pending')) not valid;
alter table conversations validate constraint conversations_state_chk;

-- A pending handoff an agent rejects now goes to its own 'rejected' state
-- instead of straight back to the bot. The bot stays quiet on a rejected
-- conversation (same as pending/human) until an agent explicitly resumes it -
-- rejecting a lead should not immediately let the bot start replying to them
-- again on its own.
alter table conversations drop constraint if exists conversations_state_chk;
alter table conversations
  add constraint conversations_state_chk check (state in ('bot', 'human', 'pending', 'rejected')) not valid;
alter table conversations validate constraint conversations_state_chk;

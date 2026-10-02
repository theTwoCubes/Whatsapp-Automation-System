-- When the AI produces an unparseable or empty-reply result, the handler
-- sends a neutral "one moment" message but has nothing real to say to the
-- lead. retry_at parks a timestamp a few minutes out so the scheduler can
-- rerun buildReply once and - if the second attempt gives a real decision -
-- deliver it. If the retry is still broken we silently clear retry_at and
-- stay quiet instead of double-sending another holding message.
alter table conversations
  add column if not exists retry_at timestamptz;

create index if not exists conversations_retry_at_idx on conversations (retry_at) where retry_at is not null;

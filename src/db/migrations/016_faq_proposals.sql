-- A handoff event per time the bot passed a chat to a person. The reason and
-- the message that triggered it are captured so the weekly refinement pass
-- can walk them by id and see exactly where the bot's knowledge fell short.
-- source is 'ai' when the model itself judged the chat needed a person, and
-- other kinds are recorded for symmetry but the refinement pass only reads
-- the ai ones since they are the ones that indicate a real knowledge gap.
create table if not exists handoff_events (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  message_id bigint references messages(id) on delete set null,
  source text not null check (source in ('ai', 'lead', 'attachment', 'keyword')),
  reason text,
  topic_id bigint references topics(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_handoff_events_ai on handoff_events (id) where source = 'ai';

-- Proposals the client reviews. Two kinds:
--   gap: the model handed off because it did not know something. A proposed
--        answer that would have covered it lands here.
--   contradiction: two active entries in a pack disagree, the offending
--        pair is linked so the client can pick one and reword or drop.
create table if not exists faq_proposals (
  id bigserial primary key,
  kind text not null check (kind in ('gap', 'contradiction')),
  topic_id bigint references topics(id) on delete cascade,
  question text,
  answer text,
  reason text,
  faq_id_a bigint references faqs(id) on delete cascade,
  faq_id_b bigint references faqs(id) on delete cascade,
  sample_conversation_ids bigint[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'approved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create index if not exists idx_faq_proposals_open on faq_proposals (kind, created_at desc) where status = 'open';

-- Cursor for the refinement pass. Extends the singleton learning_state row
-- so we do not need a second table for one number.
alter table learning_state add column if not exists last_handoff_id bigint not null default 0;

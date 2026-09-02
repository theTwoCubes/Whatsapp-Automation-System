-- Structured handoff reason category so the "why do we hand off?" report can
-- group events without parsing free text. Free-text reason is kept alongside it.
alter table handoff_events
  add column if not exists reason_category text
    check (reason_category in (
      'price_negotiation', 'custom_quote', 'complaint',
      'personal_meeting', 'unknown_service', 'unsure_answer',
      'explicit_request', 'attachment', 'other'
    ));

-- Index so the admin breakdown query is fast even with many rows.
create index if not exists handoff_events_reason_category_idx
  on handoff_events (reason_category);

-- Per-reply latency tracking: store AI and Meta round-trip ms next to each
-- outbound message so slow replies show up in the ops panel.
alter table messages
  add column if not exists ai_ms integer,
  add column if not exists meta_ms integer;

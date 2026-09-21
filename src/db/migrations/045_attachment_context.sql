-- Factual, non-judgemental note the AI extracted from an inbound image or
-- PDF (what it shows, not an opinion on it) so later turns and a human
-- reading the thread both have it without re-opening the file.
alter table messages add column if not exists attachment_context text;

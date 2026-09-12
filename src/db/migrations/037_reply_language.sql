-- Carries the language the AI is currently replying in from one turn to the
-- next, so it has a running anchor instead of re-guessing from a limited
-- history window every time - and can deliberately switch it when the lead's
-- own language changes mid-conversation.
alter table conversations add column if not exists reply_language text;

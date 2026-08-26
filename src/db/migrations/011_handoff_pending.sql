-- Handoff lifecycle gets a real pending state between the bot and a human:
-- the bot or a lead's own request moves a conversation to pending, and an
-- agent explicitly accepts (claims it) or rejects (sends it back to the bot)
-- instead of a chat silently becoming "with a human" that nobody has
-- actually picked up yet.
alter table conversations add column if not exists handoff_reason text;

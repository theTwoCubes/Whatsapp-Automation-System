-- Vision is gone. The bot is told that a file arrived and of what kind, which
-- is known for certain the moment the webhook lands, instead of being told a
-- guess at its contents that had to be waited on. Nothing writes or reads this
-- column any more.
alter table messages drop column if exists attachment_context;

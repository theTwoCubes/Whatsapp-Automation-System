-- Who started the conversation: the lead messaging in on their own ('lead'),
-- or us reaching out first via Compose or a bulk send ('business'). Existing
-- rows are all organic, hence the default.
alter table conversations add column if not exists origin text not null default 'lead';

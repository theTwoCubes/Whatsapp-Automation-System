-- Media is no longer picked by embedding similarity. The client attaches a
-- file to a specific FAQ answer, and when the bot uses that answer it can
-- send the file with it. So the vector column and its index are dead weight.
drop index if exists idx_media_assets_embedding;
alter table media_assets drop column if exists embedding;

-- Media assets become a real library: tagged to a Topic like knowledge units,
-- with a description that gets embedded so the bot can find the right file by
-- meaning instead of dumping everything tied to a topic.
alter table media_assets add column if not exists topic_id bigint references topics(id) on delete set null;
alter table media_assets add column if not exists description text;
alter table media_assets add column if not exists embedding vector(1536);

create index if not exists idx_media_assets_topic on media_assets (topic_id) where topic_id is not null;
create index if not exists idx_media_assets_embedding on media_assets using hnsw (embedding vector_cosine_ops);

-- Lets us check whether a given asset was already sent in a conversation
-- recently, so the bot leans away from resending the same file without being
-- flatly blocked from it if the lead genuinely asks again.
alter table messages add column if not exists media_asset_id bigint references media_assets(id);

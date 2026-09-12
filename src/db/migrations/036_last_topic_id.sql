-- active_pack_ids is a deduplicated, id-sorted set - it cannot tell which
-- service a conversation is CURRENTLY about once more than one comes up in
-- the same chat. This is overwritten (not merged) every time the AI newly
-- engages a service mid-conversation, so the console's service filter can
-- reflect the most recent one instead of an arbitrary member of the set.
alter table conversations add column if not exists last_topic_id bigint references topics(id) on delete set null;

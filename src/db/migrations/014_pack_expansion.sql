-- Packs a conversation has pulled in beyond the one its campaign points at.
-- Once a lead asks about another service, that pack stays in for the rest of
-- the conversation instead of being renegotiated on every message.
alter table conversations add column if not exists active_pack_ids bigint[] not null default '{}';

-- Words that should pull a pack in without asking the model first. The pack
-- name and slug are always matched, this is for the rest: brand names,
-- abbreviations and the words customers actually use for the service.
alter table topics add column if not exists keywords text;

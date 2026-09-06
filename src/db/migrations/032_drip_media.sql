-- Lets a drip step attach a file (using the same media assets already
-- uploaded to Meta for regular sends) when the underlying template has a
-- media header. header_type records what a synced template's header expects
-- (DOCUMENT/IMAGE/VIDEO/TEXT/null) so the console only offers a file picker
-- where one is actually needed.
alter table templates add column if not exists header_type text;
alter table drip_jobs add column if not exists media_asset_id bigint references media_assets(id);

-- Fix: messages.media_asset_id had no ON DELETE action, causing FK violations
-- when deleting a media asset that was ever attached to a sent message.
-- Setting ON DELETE SET NULL allows deletion and simply clears the reference.
alter table messages
  drop constraint if exists messages_media_asset_id_fkey;

alter table messages
  add constraint messages_media_asset_id_fkey
  foreign key (media_asset_id) references media_assets(id)
  on delete set null;

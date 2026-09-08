-- Lets a role change or removal revoke tokens already issued, instead of
-- letting a demoted/deleted agent keep whatever access their JWT had until
-- it naturally expires.
alter table agents add column if not exists token_version int not null default 1;

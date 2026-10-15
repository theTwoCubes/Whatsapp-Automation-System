-- Why the conversation is filed under the service it is filed under.
--
--   campaign  the lead arrived through that service's ad, which is a fact
--   stated    the customer said it themselves
--   inferred  the model's read, held provisionally and never spoken of as settled
--   unset     nothing established yet
--
-- Without this there was no way to tell a guess from a certainty, so a guess
-- behaved exactly like a fact: a tie between two similarly named services was
-- broken by table order, filed as though it were known, and then stated back
-- to the model as settled on every later turn. The basis is what lets a
-- passing mention of another service be ignored while a real switch is
-- honoured.
alter table conversations add column if not exists service_basis text;

-- Existing rows: a campaign-linked conversation genuinely knows its service.
-- Everything else was a keyword guess and is demoted to inferred, so the model
-- is free to correct it on the next turn instead of inheriting it as fact.
update conversations c set service_basis = case
  when c.service_basis is not null then c.service_basis
  when c.campaign_id is not null and exists (
    select 1 from campaigns ca where ca.id = c.campaign_id and ca.topic_id is not null
  ) then 'campaign'
  when c.last_topic_id is not null then 'inferred'
  else null
end;

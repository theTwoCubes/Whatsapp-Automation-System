-- Extra lead qualification fields the AI gathers mid-conversation. Address
-- gets its own column since every service asks for it; everything else
-- (requirement/brief, budget, timeline, and anything service-specific) goes
-- in lead_details so new fields never need another migration.
alter table contacts add column if not exists address text;
alter table contacts add column if not exists lead_details jsonb not null default '{}';

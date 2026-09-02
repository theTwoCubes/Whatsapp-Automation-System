-- Roles for agents. 'admin' can do everything, 'agent' can only work
-- conversations (not Settings, Team, Knowledge, Templates or Audit). Existing
-- agents default to admin so the app keeps working, and the seeded admin
-- (from ADMIN_EMAIL) is promoted to admin on every boot.
alter table agents add column if not exists role text not null default 'admin';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_role_chk') then
    alter table agents
      add constraint agents_role_chk check (role in ('admin', 'agent')) not valid;
    alter table agents validate constraint agents_role_chk;
  end if;
end $$;

-- Learned lazily by the AI mid-conversation (see lead-profiling in reply.js),
-- never asked for through a form - so both are nullable and commonly empty.
alter table contacts add column if not exists email text;
alter table contacts add column if not exists business text;

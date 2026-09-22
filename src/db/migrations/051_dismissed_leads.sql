-- Some contacts get a name saved but were never a real lead - a company's
-- own broadcast landing in the inbox, a wrong number, ad noise. Dismissing
-- one just removes it from the leads list/count/export; it does not touch
-- the underlying conversation or message history, so nothing is lost if it
-- turns out to matter later.
alter table contacts add column if not exists dismissed_as_lead_at timestamptz;

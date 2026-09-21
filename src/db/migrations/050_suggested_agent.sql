-- A fairness hint for who should pick up a pending handoff next, computed
-- round robin over the agents table. This never forces an assignment - any
-- agent can still accept it - it just gives the team a "whose turn is it"
-- signal instead of every pending chat being a free-for-all.
alter table conversations add column if not exists suggested_agent text;

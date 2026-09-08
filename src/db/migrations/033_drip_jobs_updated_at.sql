-- Lets the scheduler tell how long a job has sat in 'sending', so a job
-- abandoned by a crashed process (never actually reached Meta) can be
-- reclaimed and retried instead of stuck there forever.
alter table drip_jobs add column if not exists updated_at timestamptz not null default now();

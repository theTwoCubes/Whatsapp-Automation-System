-- Cursor for the weekly learning pass, so each run only scans messages added
-- since the last one instead of rescanning the whole history every time.
create table if not exists learning_state (
  id smallint primary key default 1,
  last_message_id bigint not null default 0,
  last_run_at timestamptz,
  constraint learning_state_singleton check (id = 1)
);
insert into learning_state (id, last_message_id) values (1, 0) on conflict (id) do nothing;

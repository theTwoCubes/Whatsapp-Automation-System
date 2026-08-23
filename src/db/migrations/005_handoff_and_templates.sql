alter table conversations add column if not exists assigned_at timestamptz;
alter table conversations add column if not exists last_agent_at timestamptz;

alter table templates add column if not exists status text;

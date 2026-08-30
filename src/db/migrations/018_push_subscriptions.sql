-- One row per registered browser or app. An agent may have several: laptop
-- browser, phone home-screen PWA, native APK. Delivery fans out to all of
-- them so nobody misses a handoff regardless of which device is nearby.

create table if not exists push_subscriptions (
  id            bigserial primary key,
  agent_email   text        not null,
  transport     text        not null check (transport in ('web', 'fcm')),
  endpoint      text        not null,      -- web push URL, or FCM registration token
  p256dh_key    text,                      -- web only
  auth_key      text,                      -- web only
  user_agent    text,
  platform      text,                      -- 'web', 'android', 'ios'
  created_at    timestamptz default now(),
  last_seen_at  timestamptz default now(),

  unique (transport, endpoint)
);

create index if not exists idx_push_subscriptions_agent on push_subscriptions (agent_email);

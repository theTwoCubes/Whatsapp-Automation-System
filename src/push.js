// Push notification delivery. Two transports live behind one interface: the
// standards-based Web Push protocol for browsers and installed PWAs, and FCM
// for the packaged Android APK. The rest of the code base does not care which
// device gets a message, it just calls notifyAgentsOfHandoff and this module
// walks the subscribers table.

import webpush from 'web-push';

let configured = false;

function configure() {
  if (configured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (pub && priv) {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  }
}

export function pushConfigured() {
  configure();
  return configured;
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function saveSubscription(pool, agentEmail, sub, meta = {}) {
  if (sub.transport === 'fcm') {
    await pool.query(
      `insert into push_subscriptions (agent_email, transport, endpoint, platform, user_agent)
       values ($1, 'fcm', $2, $3, $4)
       on conflict (transport, endpoint) do update set
         agent_email = excluded.agent_email,
         platform = coalesce(excluded.platform, push_subscriptions.platform),
         user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
         last_seen_at = now()`,
      [agentEmail, sub.token, meta.platform || 'android', meta.userAgent || null],
    );
    return;
  }
  await pool.query(
    `insert into push_subscriptions (agent_email, transport, endpoint, p256dh_key, auth_key, platform, user_agent)
     values ($1, 'web', $2, $3, $4, $5, $6)
     on conflict (transport, endpoint) do update set
       agent_email = excluded.agent_email,
       p256dh_key = excluded.p256dh_key,
       auth_key = excluded.auth_key,
       platform = coalesce(excluded.platform, push_subscriptions.platform),
       user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
       last_seen_at = now()`,
    [
      agentEmail,
      sub.endpoint,
      sub.keys?.p256dh || null,
      sub.keys?.auth || null,
      meta.platform || 'web',
      meta.userAgent || null,
    ],
  );
}

export async function removeSubscription(pool, endpoint) {
  await pool.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
}

// Fan out one notification to every subscribed device. Deletes stale endpoints
// on 404/410 so the table does not grow unbounded with expired browsers.
export async function notifyAgentsOfHandoff(pool, { conversationId, name, waId, reason, log }) {
  configure();
  if (!configured) return;
  const rows = (await pool.query('select * from push_subscriptions')).rows;
  if (rows.length === 0) return;

  const payload = JSON.stringify({
    title: `${name || waId} needs a person`,
    body: reason || 'A lead is waiting on your team.',
    conversationId,
    tag: `handoff-${conversationId}`,
  });

  await Promise.all(rows.map(async (row) => {
    if (row.transport === 'web') {
      try {
        await webpush.sendNotification({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh_key, auth: row.auth_key },
        }, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('delete from push_subscriptions where id = $1', [row.id]);
        } else {
          log?.warn({ err, endpoint: row.endpoint }, 'web push failed');
        }
      }
      return;
    }
    // FCM support ships in a follow up once a Firebase project exists. The
    // scaffolding is here so the frontend can already register tokens.
    log?.info({ endpoint: row.endpoint }, 'fcm push queued, delivery not yet wired');
  }));
}

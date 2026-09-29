// Push notification delivery. Two transports live behind one interface: the
// standards-based Web Push protocol for browsers and installed PWAs, and FCM
// for the packaged Android APK. The rest of the code base does not care which
// device gets a message, it just calls notifyAgentsOfHandoff and this module
// walks the subscribers table.

import webpush from 'web-push';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

let configured = false;
let fcmConfigured = false;

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

let fcmInitError = null;
function configureFcm(log) {
  if (fcmConfigured) return;
  const b64 = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!b64) return;
  try {
    const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    fcmConfigured = true;
    fcmInitError = null;
  } catch (err) {
    // malformed env var - don't crash the server
    fcmInitError = err.message;
    log?.error({ err }, 'FCM init failed');
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
// The service worker on each device decides whether to actually surface the
// notification - if the agent already has that specific chat open, the SW
// suppresses it so we don't nag them for a message they're already reading.
export async function notifyAgentsOfHandoff(pool, { conversationId, name, waId, reason, title, kind, onlyAgentEmail, log }) {
  configure();

  // Muted chats do not fan out to push. They still write to the in-app inbox
  // below, so a returning agent can catch up without being pinged live.
  const muted = (await pool.query(
    'select muted_until > now() as m from conversations where id = $1',
    [conversationId],
  )).rows[0]?.m === true;

  const notifTitle = title || `${name || waId} needs a person`;
  const notifBody = reason || 'A lead is waiting on your team.';
  const notifKind = kind === 'inbound' ? 'inbound_in_takeover' : kind === 'payment_claimed' ? 'payment_claimed' : 'handoff';

  // Inbox row: goes to every actual agent (not just ones with a push
  // subscription), so an admin who never accepted the browser push prompt
  // still sees the item in their notification drawer. onlyAgentEmail lets a
  // caller narrow this to one owner - for 'inbound' pings on a chat someone
  // is actively handling, only that agent needs to know.
  // Also includes any push-subscription owner even if they aren't (yet) in
  // the agents table, so a stale-but-still-subscribed device does not go
  // silent while a config catches up.
  const agentRows = onlyAgentEmail
    ? [{ email: onlyAgentEmail }]
    : (await pool.query(`
        select email from agents
        union
        select agent_email as email from push_subscriptions where agent_email is not null
      `)).rows;
  const agentEmails = [...new Set(agentRows.map((r) => r.email).filter(Boolean))];
  for (const agentEmail of agentEmails) {
    await pool.query(
      `insert into notifications (agent_email, kind, conversation_id, title, body)
       values ($1, $2, $3, $4, $5)`,
      [agentEmail, notifKind, conversationId, notifTitle, notifBody],
    ).catch((err) => log?.warn({ err }, 'failed to write in-app notification'));
  }

  if (muted) return;
  if (!configured) return;

  // Push subs: same narrowing when onlyAgentEmail is set.
  const rows = onlyAgentEmail
    ? (await pool.query('select * from push_subscriptions where agent_email = $1', [onlyAgentEmail])).rows
    : (await pool.query('select * from push_subscriptions')).rows;
  if (rows.length === 0) return;

  const payload = JSON.stringify({
    title: notifTitle,
    body: notifBody,
    conversationId,
    tag: `${kind === 'inbound' ? 'msg' : kind === 'payment_claimed' ? 'payment' : 'handoff'}-${conversationId}`,
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
    // FCM: send to native Android APK via Firebase
    if (row.transport === 'fcm') {
      configureFcm(log);
      if (!fcmConfigured) {
        log?.warn({ endpoint: row.endpoint }, 'fcm not configured, skipping');
        return;
      }
      try {
        await getMessaging().send({
          token: row.endpoint,
          notification: {
            title: notifTitle,
            body: notifBody,
          },
          data: { conversationId: String(conversationId || '') },
          android: { priority: 'high' },
        });
      } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered') {
          await pool.query('delete from push_subscriptions where id = $1', [row.id]);
        } else {
          log?.warn({ err, endpoint: row.endpoint }, 'fcm push failed');
        }
      }
      return;
    }
  }));
}

// Returns diagnostic info about push for a given agent
export async function getPushStatus(pool, agentEmail) {
  configure();
  const all = (await pool.query('select count(*) as n from push_subscriptions')).rows[0].n;
  const mine = (await pool.query(
    `select id, transport, platform,
       split_part(endpoint, '/', 3) as endpoint_host,
       created_at, last_seen_at
     from push_subscriptions where agent_email = $1`,
    [agentEmail],
  )).rows;
  return {
    vapidConfigured: configured,
    myEndpoints: mine,
    totalSubscriptions: Number(all),
  };
}

// Sends a test push to only the calling agent's subscriptions
export async function sendTestPush(pool, agentEmail, log) {
  configure();
  if (!configured) {
    throw new Error('Notifications are not configured on the server. Run node scripts/generate-vapid.js >> .env and restart.');
  }
  const rows = (await pool.query(
    'select * from push_subscriptions where agent_email = $1',
    [agentEmail],
  )).rows;
  if (rows.length === 0) {
    return { ok: true, sent: 0, errors: ['No subscription found for this device. Try turning notifications on again.'] };
  }
  const payload = JSON.stringify({
    title: 'Test notification',
    body: 'If you see this, push is working.',
    tag: 'push-test',
  });
  const errors = [];
  let sent = 0;
  await Promise.all(rows.map(async (row) => {
    if (row.transport === 'web') {
      try {
        await webpush.sendNotification({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh_key, auth: row.auth_key },
        }, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('delete from push_subscriptions where id = $1', [row.id]);
          errors.push(`Endpoint expired (${err.statusCode}) - unsubscribed`);
        } else {
          errors.push(err.message);
          log?.warn({ err }, 'test push failed');
        }
      }
    } else if (row.transport === 'fcm') {
      configureFcm(log);
      if (!fcmConfigured) {
        errors.push('FCM not configured on server (FCM_SERVICE_ACCOUNT_JSON missing)');
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        await getMessaging().send({
          token: row.endpoint,
          notification: { title: parsed.title, body: parsed.body },
          android: { priority: 'high' },
        });
        sent++;
      } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered') {
          await pool.query('delete from push_subscriptions where id = $1', [row.id]);
          errors.push('FCM token expired - unsubscribed');
        } else {
          errors.push(err.message);
          log?.warn({ err }, 'test fcm push failed');
        }
      }
    }
  }));
  return { ok: true, sent, errors };
}

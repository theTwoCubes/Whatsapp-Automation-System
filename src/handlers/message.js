import { recordInbound, recordOutbound, updateStatus } from '../db/repo.js';
import { buildReply } from '../ai/reply.js';

// Handles a verified webhook payload. Runs after the route has already returned
// 200, so it must not throw back to the request. Messages and status callbacks
// arrive on the same endpoint with different shapes and are handled separately.
export async function processWebhook(body, deps) {
  const { meta, ai, pool, config, log } = deps;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (value.messages?.length) {
        for (const msg of value.messages) {
          await handleMessage(value, msg, { meta, ai, pool, config, log });
        }
      }

      if (value.statuses?.length) {
        for (const status of value.statuses) {
          await handleStatus(status, { pool, log });
        }
      }
    }
  }
}

async function handleMessage(value, message, deps) {
  const { ai, pool, config, log } = deps;
  const contactName = value.contacts?.[0]?.profile?.name;

  let result;
  try {
    result = await recordInbound(pool, {
      waId: message.from,
      name: contactName,
      waMessageId: message.id,
      type: message.type,
      body: message.text?.body ?? null,
      referral: message.referral ?? null,
      raw: message,
    });
  } catch (err) {
    log.error({ wamid: message.id, err }, 'failed to record inbound message');
    return;
  }

  if (!result.isNew) {
    log.info({ wamid: message.id }, 'duplicate message, skipping');
    return;
  }

  log.info(
    {
      wamid: message.id,
      from: message.from,
      type: message.type,
      contactName,
      conversationId: result.conversationId,
      campaignId: result.campaignId,
    },
    result.campaignId ? 'inbound message received from ad campaign' : 'inbound message received',
  );

  if (message.type !== 'text' || !message.text?.body) {
    log.info({ wamid: message.id, type: message.type }, 'non text message, no reply');
    return;
  }

  // AI reply. Any failure, including no api key, falls back to a canned message
  // so the lead always gets an answer.
  let reply;
  try {
    reply = await buildReply(pool, ai, config, result.conversationId);
  } catch (err) {
    log.warn({ conversationId: result.conversationId, err }, 'ai reply unavailable, using fallback');
  }
  if (!reply) reply = config.fallbackMessage;

  await sendAndRecord(deps, message.from, result.conversationId, reply);
}

async function sendAndRecord(deps, to, conversationId, body) {
  const { meta, pool, log } = deps;
  try {
    const wamid = await meta.sendText(to, body);
    if (wamid) {
      await recordOutbound(pool, { conversationId, waMessageId: wamid, body });
    }
  } catch (err) {
    log.error({ conversationId, to, err }, 'failed to send reply');
  }
}

async function handleStatus(status, deps) {
  const { pool, log } = deps;
  try {
    await updateStatus(pool, { waMessageId: status.id, status: status.status });
  } catch (err) {
    log.error({ wamid: status.id, err }, 'failed to update message status');
  }
  const base = { wamid: status.id, status: status.status, recipient: status.recipient_id };
  if (status.status === 'failed') {
    log.warn({ ...base, errors: status.errors }, 'message status: failed');
  } else {
    log.info(base, `message status: ${status.status}`);
  }
}

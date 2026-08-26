import { recordInbound, recordOutbound, updateStatus, scheduleDrips, cancelDrips } from '../db/repo.js';
import { buildReply, wantsHuman } from '../ai/reply.js';
import { handToHuman } from '../handoff.js';
import { getSettings } from '../settings.js';

// Handles a verified webhook payload. Runs after the route has already returned
// 200, so it must not throw back to the request. Messages and status callbacks
// arrive on the same endpoint with different shapes and are handled separately.
export async function processWebhook(body, deps) {
  const { meta, ai, embeddings, pool, config, realtime, log } = deps;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (value.messages?.length) {
        for (const msg of value.messages) {
          await handleMessage(value, msg, { meta, ai, embeddings, pool, config, realtime, log });
        }
      }

      if (value.statuses?.length) {
        for (const status of value.statuses) {
          await handleStatus(status, { pool, realtime, log });
        }
      }
    }
  }
}

async function handleMessage(value, message, deps) {
  const { ai, embeddings, pool, config, realtime, log } = deps;
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

  realtime?.emit({ type: 'refresh', conversationId: result.conversationId });

  // A human owns this conversation, so the bot stays out of it.
  if (result.state !== 'bot') {
    log.info({ conversationId: result.conversationId }, 'conversation is with a human, bot staying quiet');
    return;
  }

  if (message.type !== 'text' || !message.text?.body) {
    log.info({ wamid: message.id, type: message.type }, 'non text message, no reply');
    return;
  }

  const text = message.text.body;
  const settings = await getSettings(pool, config);

  // The lead asked for a person. Hand off, stop the drip follow ups, and let the
  // team take it from here.
  if (wantsHuman(text)) {
    await handToHuman(pool, result.conversationId);
    await cancelDrips(pool, result.conversationId);
    log.info({ conversationId: result.conversationId }, 'handed conversation to a human on request');
    await sendAndRecord(deps, message.from, result.conversationId, settings.handoffMessage);
    return;
  }

  // AI reply. The model returns a reply plus its own judgement on whether a
  // human should take over. Any failure, including no api key, falls back to a
  // canned message so the lead always gets an answer. Retrieval is scored
  // against the message text and biased by the lead's topic if the campaign is
  // linked to one.
  let decision;
  try {
    decision = await buildReply(pool, ai, embeddings, settings, result.conversationId, {
      query: text,
      topicId: result.topicId ?? null,
    });
  } catch (err) {
    log.warn({ conversationId: result.conversationId, err }, 'ai reply unavailable, using fallback');
  }

  // The AI decided this needs a person.
  if (decision?.handoff) {
    await handToHuman(pool, result.conversationId);
    await cancelDrips(pool, result.conversationId);
    log.info({ conversationId: result.conversationId, reason: decision.reason }, 'ai handed conversation to a human');
    await sendAndRecord(deps, message.from, result.conversationId, decision.reply || settings.handoffMessage);
    return;
  }

  const reply = decision?.reply || settings.fallbackMessage;
  await sendAndRecord(deps, message.from, result.conversationId, reply);

  // The lead is active, so reset the follow up schedule from now.
  await scheduleDrips(pool, result.conversationId, settings.dripSteps);
}

async function sendAndRecord(deps, to, conversationId, body) {
  const { meta, pool, realtime, log } = deps;
  try {
    const wamid = await meta.sendText(to, body);
    if (wamid) {
      await recordOutbound(pool, { conversationId, waMessageId: wamid, body });
      realtime?.emit({ type: 'refresh', conversationId });
    }
  } catch (err) {
    log.error({ conversationId, to, err }, 'failed to send reply');
  }
}

async function handleStatus(status, deps) {
  const { pool, realtime, log } = deps;
  try {
    await updateStatus(pool, { waMessageId: status.id, status: status.status });
    realtime?.emit({ type: 'status', wamid: status.id, status: status.status });
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

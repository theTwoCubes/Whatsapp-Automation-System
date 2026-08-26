import {
  recordInbound,
  recordOutbound,
  updateStatus,
  scheduleDrips,
  cancelDrips,
  getConversationState,
  wasMediaSentRecently,
} from '../db/repo.js';
import { buildReply, wantsHuman } from '../ai/reply.js';
import { retrieveMedia } from '../knowledge/media.js';
import { handToPending } from '../handoff.js';
import { getSettings } from '../settings.js';
import { createBatcher } from './batcher.js';

// Rapid fire messages from the same lead get coalesced into one AI call
// instead of a reply per message. In process, single instance is fine for
// now, same as the drip scheduler. Built lazily from config on first use.
let batcher = null;
function getBatcher(config) {
  if (!batcher) {
    batcher = createBatcher({ debounceMs: config.messageBatchDebounceMs, maxWaitMs: config.messageBatchMaxWaitMs });
  }
  return batcher;
}

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
  const { pool, config, realtime, log } = deps;
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

  // Anything the lead sends that is not plain text (image, document, voice
  // note, location, and so on) needs a person, not a silent drop. Handing off
  // immediately means it does not get lost waiting on the debounce window.
  if (message.type !== 'text' || !message.text?.body) {
    const settings = await getSettings(pool, config);
    await handToPending(pool, result.conversationId, `Lead sent a ${message.type}`);
    await cancelDrips(pool, result.conversationId);
    log.info({ conversationId: result.conversationId, type: message.type }, 'lead sent an attachment, queued for a human');
    await sendAndRecord(deps, message.from, result.conversationId, settings.attachmentMessage);
    return;
  }

  const items = await getBatcher(config).enqueueMessage(result.conversationId, {
    wamid: message.id,
    to: message.from,
    conversationId: result.conversationId,
    topicId: result.topicId ?? null,
    text: message.text.body,
  });

  // Only the call holding the last message in the flushed batch replies, the
  // rest already recorded their message and can return quietly.
  const leader = items[items.length - 1];
  if (leader.wamid !== message.id) return;

  await respondToLead(deps, result.conversationId, items);
}

async function respondToLead(deps, conversationId, items) {
  const { pool, embeddings, ai, config } = deps;
  const log = deps.log;

  // A handoff may have happened elsewhere while this batch sat in its
  // debounce window, re-check instead of racing past it.
  const state = await getConversationState(pool, conversationId);
  if (state !== 'bot') {
    log.info({ conversationId }, 'conversation moved to a human during batching, skipping bot reply');
    return;
  }

  const to = items[items.length - 1].to;
  const topicId = items[items.length - 1].topicId;
  const text = items.map((i) => i.text).join('\n');
  const settings = await getSettings(pool, config);

  // The lead asked for a person. Hand off, stop the drip follow ups, and let the
  // team take it from here.
  if (wantsHuman(text)) {
    await handToPending(pool, conversationId, 'Lead asked to speak with a person');
    await cancelDrips(pool, conversationId);
    log.info({ conversationId }, 'queued conversation for a human on request');
    await sendAndRecord(deps, to, conversationId, settings.handoffMessage);
    return;
  }

  // AI reply. The model returns a reply plus its own judgement on whether a
  // human should take over. Any failure, including no api key, falls back to a
  // canned message so the lead always gets an answer. Retrieval is scored
  // against the message text and biased by the lead's topic if the campaign is
  // linked to one.
  let decision;
  try {
    decision = await buildReply(pool, ai, embeddings, settings, conversationId, {
      query: text,
      topicId,
      topK: config.retrievalTopK,
      tokenBudget: config.retrievalTokenBudget,
      similarityFloor: config.retrievalSimilarityFloor,
    });
  } catch (err) {
    log.warn({ conversationId, err }, 'ai reply unavailable, using fallback');
  }

  // The AI decided this needs a person.
  if (decision?.handoff) {
    await handToPending(pool, conversationId, decision.reason || 'The ai judged this needs a person');
    await cancelDrips(pool, conversationId);
    log.info({ conversationId, reason: decision.reason }, 'ai queued conversation for a human');
    await sendAndRecord(deps, to, conversationId, decision.reply || settings.handoffMessage);
    return;
  }

  const reply = decision?.reply || settings.fallbackMessage;
  await sendAndRecord(deps, to, conversationId, reply);
  await maybeSendMedia(deps, conversationId, to, text, topicId);

  // The lead is active, so reset the follow up schedule from now.
  await scheduleDrips(pool, conversationId, settings.dripSteps);
}

// Looks for a media asset closely matching what the lead asked about and
// sends it along, leaning away from resending the same file recently without
// being hard blocked from it.
async function maybeSendMedia(deps, conversationId, to, query, topicId) {
  const { pool, embeddings, meta, realtime, log, config } = deps;
  try {
    const asset = await retrieveMedia(pool, embeddings, query, {
      topicId,
      similarityFloor: config.mediaSimilarityFloor,
    });
    if (!asset) return;

    const recently = await wasMediaSentRecently(pool, conversationId, asset.id, config.mediaResendCooldownMinutes);
    if (recently) return;

    const wamid = await meta.sendMedia(to, asset.kind, {
      id: asset.meta_media_id,
      caption: asset.caption,
      filename: asset.filename,
    });
    if (wamid) {
      await recordOutbound(pool, {
        conversationId,
        waMessageId: wamid,
        type: asset.kind,
        body: asset.caption || `[${asset.kind}] ${asset.filename ?? ''}`.trim(),
        mediaAssetId: asset.id,
      });
      realtime?.emit({ type: 'refresh', conversationId });
    }
  } catch (err) {
    log.warn({ conversationId, err }, 'failed to auto send matching media');
  }
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

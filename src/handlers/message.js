import {
  recordInbound,
  recordOutbound,
  recordHandoff,
  updateStatus,
  scheduleDrips,
  cancelDrips,
  getConversationState,
  getActivePackIds,
  addActivePackIds,
  getMediaAsset,
  wasMediaSentRecently,
  markInboundRead,
  isConversationBlocked,
  deadLetterWebhook,
} from '../db/repo.js';
import { buildReply, wantsHuman, isSimpleGreeting, categorizeHandoffReason } from '../ai/reply.js';
import { recordWebhook, recordAiSuccess, recordAiError, recordMetaLatency } from '../ai/telemetry.js';
import { getFaq } from '../knowledge/faqs.js';
import { keywordPacks } from '../knowledge/packs.js';
import { handToPending } from '../handoff.js';
import { notifyAgentsOfHandoff } from '../push.js';

// Fires a push to every subscribed device. Fetches contact bits in a single
// query so the caller does not need to pass them in from every handoff site.
// opts.kind picks the title shown on the phone:
//   'handoff' (default) → "<name> needs a person"
//   'inbound'           → "<name> sent a message"
async function pushHandoff(pool, conversationId, reason, log, opts = {}) {
  try {
    const res = await pool.query(
      `select ct.name, ct.wa_id
       from conversations c join contacts ct on ct.id = c.contact_id
       where c.id = $1`,
      [conversationId],
    );
    const row = res.rows[0];
    const label = row?.name || row?.wa_id;
    const title = opts.kind === 'inbound'
      ? `${label} sent a message`
      : `${label} needs a person`;
    await notifyAgentsOfHandoff(pool, {
      conversationId,
      name: row?.name,
      waId: row?.wa_id,
      reason,
      title,
      kind: opts.kind || 'handoff',
      log,
    });
  } catch (err) {
    log?.warn({ err, conversationId }, 'handoff push failed');
  }
}
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
  const { meta, ai, pool, config, realtime, log } = deps;

  recordWebhook();
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      // Each change is isolated: if one throws, park it in the dead-letter
      // table and keep processing the rest instead of losing the whole batch.
      try {
        if (value.messages?.length) {
          for (const msg of value.messages) {
            await handleMessage(value, msg, { meta, ai, pool, config, realtime, log });
          }
        }

        if (value.statuses?.length) {
          for (const status of value.statuses) {
            await handleStatus(status, { pool, realtime, log });
          }
        }
      } catch (err) {
        log.error({ err }, 'webhook change failed, parking in dead-letter');
        await deadLetterWebhook(pool, change, err.message).catch((dlErr) =>
          log.error({ dlErr }, 'failed to write dead-letter row'),
        );
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
      // WhatsApp sends timestamp as a Unix seconds string. Convert to ms.
      sentAt: message.timestamp ? Number(message.timestamp) * 1000 : null,
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

  // Blocked lead: the message is stored (so there's a record) but the bot
  // never replies, no handoff, no drip, no push. It just sits, ignored.
  if (await isConversationBlocked(pool, result.conversationId)) {
    log.info({ conversationId: result.conversationId }, 'conversation is blocked, ignoring inbound');
    return;
  }

  // A human owns this conversation, so the bot stays out of it. The team
  // still needs to know a new message landed, so fire a push. The service
  // worker suppresses it if the agent already has that specific chat open.
  // The preview is kept short and generic — full message content stays inside
  // the app so lock-screen previews cannot leak sensitive strings from a lead.
  if (result.state !== 'bot') {
    log.info({ conversationId: result.conversationId }, 'conversation is with a human, bot staying quiet');
    if (message.text?.body || message.type !== 'text') {
      const preview = message.text?.body
        ? 'New message'
        : `Sent a ${message.type}`;
      await pushHandoff(pool, result.conversationId, preview, log, { kind: 'inbound' });
    }
    return;
  }

  // Anything the lead sends that is not plain text (image, document, voice
  // note, location, and so on) needs a person, not a silent drop. Handing off
  // immediately means it does not get lost waiting on the debounce window.
  if (message.type !== 'text' || !message.text?.body) {
    const settings = await getSettings(pool, config);
    await handToPending(pool, result.conversationId, `Lead sent a ${message.type}`);
    await recordHandoff(pool, {
      conversationId: result.conversationId,
      source: 'attachment',
      reason: `Lead sent a ${message.type}`,
      topicId: result.topicId ?? null,
    });
    await cancelDrips(pool, result.conversationId);
    log.info({ conversationId: result.conversationId, type: message.type }, 'lead sent an attachment, queued for a human');
    await sendAndRecord(deps, message.from, result.conversationId, settings.attachmentMessage);
    await pushHandoff(pool, result.conversationId, `Lead sent a ${message.type}`, log);
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
  const { pool, ai, config } = deps;
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
    const reason = 'Lead asked to speak with a person';
    await handToPending(pool, conversationId, reason);
    await recordHandoff(pool, {
      conversationId,
      source: 'lead',
      reason,
      reasonCategory: 'explicit_request',
      topicId,
    });
    await cancelDrips(pool, conversationId);
    log.info({ conversationId }, 'queued conversation for a human on request');
    await sendAndRecord(deps, to, conversationId, settings.handoffMessage);
    await pushHandoff(pool, conversationId, reason, log);
    return;
  }

  // AI reply. The bot is given the base pack, the lead's own service pack, any
  // packs the conversation has previously pulled in, and any pack whose name or
  // keywords match the text of this message. It can also ask for one more pack
  // by name from the catalog, in which case we pull it in and call back once.
  const packs = await assemblePacks(pool, conversationId, topicId, text);
  let decision;
  const aiStart = Date.now();
  try {
    decision = await buildReply(pool, ai, settings, conversationId, {
      packs,
      faqBudgetTokens: config.faqBudgetTokens,
      text,
    });
    // The model asked for extra packs. Add them, mark them sticky for the rest
    // of the conversation, and call back once with pack requests disabled so a
    // stubborn model can never loop asking for pack after pack.
    if (decision?.requestedPackIds?.length) {
      log.info({ conversationId, packs: decision.requestedPackIds }, 'ai requested more packs');
      await addActivePackIds(pool, conversationId, decision.requestedPackIds);
      decision = await buildReply(pool, ai, settings, conversationId, {
        packs: [...packs, ...decision.requestedPackIds],
        faqBudgetTokens: config.faqBudgetTokens,
        allowPackRequests: false,
      });
    }
    const aiMs = Date.now() - aiStart;
    recordAiSuccess(aiMs);
    log.info({ conversationId, aiMs, handoff: decision?.handoff }, 'ai reply built');
  } catch (err) {
    const aiMs = Date.now() - aiStart;
    recordAiError();
    log.warn({ conversationId, aiMs, err }, 'ai reply unavailable, using fallback');
    decision = {
      handoff: true,
      reason: 'AI service unavailable',
      reply: settings.fallbackMessage,
    };
  }

  // The AI decided this needs a person.
  if (decision?.handoff) {
    const reason = decision.reason || 'The ai judged this needs a person';
    const reasonCategory = categorizeHandoffReason(reason);
    await handToPending(pool, conversationId, reason);
    await recordHandoff(pool, { conversationId, source: 'ai', reason, reasonCategory, topicId });
    await cancelDrips(pool, conversationId);
    log.info({ conversationId, reason, reasonCategory }, 'ai queued conversation for a human');
    await sendAndRecord(deps, to, conversationId, decision.reply || settings.handoffMessage);
    await pushHandoff(pool, conversationId, reason, log);
    return;
  }

  const reply = decision?.reply || settings.fallbackMessage;
  await sendAndRecord(deps, to, conversationId, reply);
  if (decision?.sendFaqId) {
    await maybeSendFaqMedia(deps, conversationId, to, decision.sendFaqId);
  }

  // The lead is active, so reset the follow up schedule from now.
  await scheduleDrips(pool, conversationId, settings.dripSteps);
}

// The packs going into this reply: base is always there, the lead's own
// campaign pack if any, anything the conversation has already pulled in, and
// anything whose name or keywords match the current message. Duplicates are
// collapsed later by the context builder, so ordering just controls which
// entries survive if the budget is exceeded: campaign pack first, then
// sticky picks in the order they were added, then keyword matches on this
// turn last.
async function assemblePacks(pool, conversationId, campaignTopicId, text) {
  const packs = ['base'];
  const seen = new Set();
  const add = (id) => {
    const key = String(id);
    if (id != null && !seen.has(key)) {
      seen.add(key);
      packs.push(Number(id));
    }
  };

  if (campaignTopicId) add(campaignTopicId);

  const sticky = await getActivePackIds(pool, conversationId);
  for (const id of sticky) add(id);

  const excluded = [...seen];
  const keyword = await keywordPacks(pool, text, excluded);
  for (const id of keyword) add(id);
  if (keyword.length > 0) await addActivePackIds(pool, conversationId, keyword);

  return packs;
}

// Sends the file the client attached to a specific FAQ, when the model asked
// for it as part of its reply. The cooldown stops the bot from resending the
// same file to the same conversation within a window, without hard blocking a
// lead who genuinely asks for it again later.
async function maybeSendFaqMedia(deps, conversationId, to, faqId) {
  const { pool, meta, realtime, log, config } = deps;
  try {
    const faq = await getFaq(pool, faqId);
    if (!faq?.media_asset_id) return;

    const asset = await getMediaAsset(pool, faq.media_asset_id);
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
    log.warn({ conversationId, faqId, err }, 'failed to send faq attachment');
  }
}

async function sendAndRecord(deps, to, conversationId, body, { aiMs = null } = {}) {
  const { meta, pool, realtime, log } = deps;
  try {
    const readWamid = await markInboundRead(pool, conversationId);
    if (readWamid) {
      meta.markRead(readWamid).catch(err => log.error({ err, wamid: readWamid }, 'failed to mark message read on meta before bot reply'));
    }

    const metaStart = Date.now();
    const wamid = await meta.sendText(to, body);
    const metaMs = Date.now() - metaStart;
    recordMetaLatency(metaMs);

    if (wamid) {
      await recordOutbound(pool, { conversationId, waMessageId: wamid, body, aiMs, metaMs });
      realtime?.emit({ type: 'refresh', conversationId });
    }
    log.info({ conversationId, metaMs }, 'reply sent to meta');
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

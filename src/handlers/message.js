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
  setLastTopicId,
  setReplyLanguage,
  setLockedLanguage,
  setLeadProfile,
  markIntroduced,
  reconcileContactWaId,
  getMediaAsset,
  wasMediaSentRecently,
  getPaymentLink,
  getHostedLink,
  markInboundRead,
  isConversationBlocked,
  setConversationBlocked,
  deadLetterWebhook,
  countRecentAttachments,
  saveAttachmentContext,
  optOutContact,
  isContactOptedOut,
  recordPaymentClaimed,
  markConversationAsPeerBot,
  recentOutboundStats,
  isLeadQualifiedEnough,
  scheduleRetry,
} from '../db/repo.js';
import { buildReply, categorizeHandoffReason } from '../ai/reply.js';
import { describeAttachment } from '../ai/vision.js';
import { recordWebhook, recordAiSuccess, recordAiError, recordMetaLatency } from '../ai/telemetry.js';
import { keywordPacks } from '../knowledge/packs.js';
import { getTopic } from '../knowledge/topics.js';
import { parseDripSteps } from '../config.js';
import { handToPending } from '../handoff.js';
import { notifyAgentsOfHandoff } from '../push.js';
import { captureError } from '../monitoring.js';

// Fires a push notification. Fetches contact + assignee in a single query so
// callers don't need to pass them in. opts.kind picks the title shown:
//   'handoff' (default)  → "<name> needs a person" (fans out to all agents)
//   'inbound'            → "<name> sent a message" (only to the assignee)
//   'payment_claimed'    → "<name> says they paid" (fans out to all agents)
//
// The 'inbound' variant is the notification for a message landing in a chat
// a human agent is already handling: only the owner of that chat needs to
// know, everyone else on the team would just be pinged for a conversation
// they aren't involved in.
export async function pushHandoff(pool, conversationId, reason, log, opts = {}) {
  try {
    const res = await pool.query(
      `select ct.name, ct.wa_id, c.assignee
       from conversations c join contacts ct on ct.id = c.contact_id
       where c.id = $1`,
      [conversationId],
    );
    const row = res.rows[0];
    const label = row?.name || row?.wa_id;
    const title = opts.kind === 'inbound'
      ? `${label} sent a message`
      : opts.kind === 'payment_claimed'
        ? `${label} says they paid`
        : `${label} needs a person`;
    await notifyAgentsOfHandoff(pool, {
      conversationId,
      name: row?.name,
      waId: row?.wa_id,
      reason,
      title,
      kind: opts.kind || 'handoff',
      onlyAgentEmail: opts.kind === 'inbound' ? row?.assignee : null,
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
        captureError(err, { where: 'processWebhook' });
        await deadLetterWebhook(pool, change, err.message).catch((dlErr) =>
          log.error({ dlErr }, 'failed to write dead-letter row'),
        );
      }
    }
  }
}

// A lead tapping a quick-reply button - either on a template ("button") or
// an interactive button/list message ("interactive") - carries the text they
// picked. Returns null for every other type, including a fully custom
// interactive reply (e.g. a Flow submission) this does not attempt to
// interpret as text.
function extractQuickReplyText(message) {
  if (message.type === 'button') return message.button?.text || null;
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
  }
  return null;
}

// A short, human-readable stand-in for the message types that carry no text
// of their own, so the console thread, search, and any handoff/notification
// text shows something meaningful instead of a blank body. Covers every
// inbound type WhatsApp can send that is not already handled on its own
// (reactions are recorded and handled separately; image/document/video/audio
// keep their existing media-card rendering and need no text body here).
function describeInboundBody(message, quickReplyText) {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? null;
    case 'button':
    case 'interactive':
      return quickReplyText ? `Tapped: ${quickReplyText}` : null;
    case 'image':
    case 'document':
    case 'video':
    case 'audio':
      // Captions WhatsApp lets a lead attach to a file go on the message
      // body itself so the console thread shows "lead's words + the file"
      // (the media card renders separately above the body text). Without
      // this the admin would only see the file icon with no idea what the
      // customer actually wrote alongside it.
      return message[message.type]?.caption?.trim() || null;
    case 'location': {
      const loc = message.location;
      return loc?.name ? `Location shared: ${loc.name}` : 'Location shared';
    }
    case 'contacts': {
      const names = (message.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean);
      return names.length ? `Contact card shared: ${names.join(', ')}` : 'Contact card shared';
    }
    case 'order': {
      const count = message.order?.product_items?.length;
      return count ? `Order sent: ${count} item${count === 1 ? '' : 's'}` : 'Order sent';
    }
    case 'system':
      return message.system?.body || 'System notice from WhatsApp';
    case 'unsupported':
      return 'Sent something this cannot read (an unsupported message type)';
    default:
      return null;
  }
}

// Hard, deterministic opt-out phrases - checked before the AI ever sees the
// message, so honouring a stop request never depends on a model call
// succeeding or interpreting it correctly. Anchored to (close to) the whole
// message rather than "contains stop" anywhere, since that word shows up in
// plenty of unrelated sentences. Deliberately narrow and English-only - softer
// phrasing, other languages, and anything more conversational than this is
// still caught by the AI's own "opt_out" action (see ai/reply.js), this is
// only the unambiguous fast path.
const OPT_OUT_PATTERNS = [
  /^stop$/i,
  /^unsubscribe$/i,
  /^unsub$/i,
  /^opt.?out$/i,
  /^remove me$/i,
  /^stop (messaging|texting|contacting)( me)?$/i,
  /^please stop( messaging| texting| contacting)?( me)?$/i,
  /^do(n'?t| not) (message|text|contact) me( again)?$/i,
];

function isOptOutRequest(text) {
  const trimmed = (text || '').trim().replace(/[.!]+$/, '');
  return OPT_OUT_PATTERNS.some((re) => re.test(trimmed));
}

async function handleMessage(value, message, deps) {
  const { pool, meta, config, realtime, log } = deps;
  const contactName = value.contacts?.[0]?.profile?.name;

  // A tapped quick-reply button (on a template, or an interactive button/list
  // message) is a structured answer the lead chose, not an attachment - it
  // gets treated as if they had typed it, going straight to the AI pipeline
  // below instead of being handled as a file.
  const quickReplyText = extractQuickReplyText(message);
  // WhatsApp lets a lead send an image/document/video with a caption attached
  // in the same message. The structured body is on message[type].caption,
  // not message.text - treat that caption as the lead's actual words so the
  // AI sees "look at this - can you review?" alongside the file, instead of
  // dropping the text and only seeing "Sent an image".
  const attachmentCaption =
    message.image?.caption?.trim()
    || message.document?.caption?.trim()
    || message.video?.caption?.trim()
    || null;
  let effectiveText = message.text?.body || quickReplyText || attachmentCaption || null;

  let result;
  try {
    result = await recordInbound(pool, {
      waId: message.from,
      name: contactName,
      waMessageId: message.id,
      type: message.type,
      body: describeInboundBody(message, quickReplyText),
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

  // A reaction is a signal, not a message. It needs no reply from the bot and
  // no handoff to a person - WhatsApp itself does not treat a reaction as
  // something requiring a response. recordInbound above already stored it
  // (message_id and emoji live inside raw), and the realtime refresh a few
  // lines up already told the console to redraw, so there is nothing left to
  // do here except stop before the generic non-text handling below treats it
  // like an attachment and wrongly hands the chat to a person.
  if (message.type === 'reaction') {
    log.info({ conversationId: result.conversationId }, 'lead reacted to a message');
    return;
  }

  // A human owns this conversation, so the bot stays out of it. The team
  // still needs to know a new message landed, so fire a push. The service
  // worker suppresses it if the agent already has that specific chat open.
  // The preview is kept short and generic - full message content stays inside
  // the app so lock-screen previews cannot leak sensitive strings from a lead.
  if (result.state !== 'bot') {
    log.info({ conversationId: result.conversationId }, 'conversation is with a human, bot staying quiet');
    if (effectiveText || message.type !== 'text') {
      const preview = effectiveText ? 'New message' : `Sent a ${message.type}`;
      await pushHandoff(pool, result.conversationId, preview, log, { kind: 'inbound' });
    }
    return;
  }

  // An unambiguous opt-out is honoured immediately, before the AI or the
  // debounce batcher ever see it - drips stop right away and stay stopped
  // for this contact everywhere (bulk sends too), not just this chat.
  if (message.type === 'text' && isOptOutRequest(effectiveText)) {
    const settings = await getSettings(pool, config);
    await optOutContact(pool, result.conversationId);
    log.info({ conversationId: result.conversationId }, 'lead opted out, drips cancelled');
    await sendAndRecord(deps, message.from, result.conversationId, settings.optOutMessage);
    return;
  }

  // Anything the lead sends that is not plain text or a quick-reply tap
  // (image, document, voice note, location, and so on) is no longer an
  // automatic handoff - only a qualified lead gets passed to a person, and
  // a file on its own says nothing about that either way. It goes through
  // the exact same AI pipeline as a text message. Caption text (if any)
  // becomes effectiveText so the AI reads what the lead typed; vision runs
  // IN ADDITION (not instead) and the factual note is stored on the message
  // as attachment_context so the prompt sees "caption text - what the
  // image shows" together. If there's no caption, effectiveText falls back
  // to a generic "Sent a <type>" label.
  const isAttachment = message.type === 'image' || message.type === 'document'
    || message.type === 'video' || message.type === 'audio' || message.type === 'sticker';
  if (isAttachment) {
    if (!effectiveText) effectiveText = `Sent a ${message.type}`;

    if (message.type === 'image' || message.type === 'document') {
      const recentCount = await countRecentAttachments(pool, result.conversationId, 60);
      if (recentCount > config.mediaAnalysisMaxPerHour) {
        log.info({ conversationId: result.conversationId, recentCount }, 'attachment analysis rate limit hit, skipping vision');
      } else {
        try {
          const mediaId = message[message.type]?.id;
          if (mediaId) {
            const url = await meta.getMediaUrl(mediaId);
            const { buffer, contentType } = await meta.downloadMedia(url);
            // Read the live Gemini key from settings, not the boot env config -
            // otherwise an admin rotating the key from the console silently
            // keeps using the old one for every inbound image/PDF.
            const visionSettings = await getSettings(pool, config);
            const note = await describeAttachment(visionSettings, buffer, contentType, log);
            if (note) {
              await saveAttachmentContext(pool, result.messageId, note);
            }
          }
        } catch (err) {
          log.warn({ err, conversationId: result.conversationId }, 'attachment analysis failed, continuing without it');
        }
      }
    }
  } else if (!effectiveText) {
    effectiveText = `Sent a ${message.type}`;
  }

  const items = await getBatcher(config).enqueueMessage(result.conversationId, {
    wamid: message.id,
    to: message.from,
    conversationId: result.conversationId,
    topicId: result.topicId ?? null,
    text: effectiveText,
  });

  // Only the call holding the last message in the flushed batch replies, the
  // rest already recorded their message and can return quietly.
  const leader = items[items.length - 1];
  if (leader.wamid !== message.id) return;

  await respondToLead(deps, result.conversationId, items);
}

// Cheap defensive check before every AI call: if we've sent a lot of bot
// replies to this contact in a short window and still know nothing about who
// they are, the other side is almost certainly automated. Silently mark it
// as a peer bot and skip the AI call entirely, so a stuck loop caps at
// whatever the threshold is instead of eating the API bill.
const PEER_BOT_LOOP_MAX_REPLIES = 6;
const PEER_BOT_LOOP_WINDOW_MIN = 15;

async function tripPeerBotSafetyNet(pool, conversationId, log) {
  const { recentOutbound, hasLeadInfo } = await recentOutboundStats(pool, conversationId, PEER_BOT_LOOP_WINDOW_MIN);
  if (recentOutbound < PEER_BOT_LOOP_MAX_REPLIES) return false;
  if (hasLeadInfo) return false;
  await markConversationAsPeerBot(pool, conversationId, `auto: ${recentOutbound} replies in ${PEER_BOT_LOOP_WINDOW_MIN}m, no lead info`);
  await cancelDrips(pool, conversationId);
  log.info({ conversationId, recentOutbound }, 'peer-bot safety net tripped, conversation blocked silently');
  return true;
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

  // Safety net: catch a peer-bot loop even if the AI itself has not flagged
  // it yet. Runs before the AI call so a stuck loop never gets a chance to
  // burn through another round of tokens.
  if (await tripPeerBotSafetyNet(pool, conversationId, log)) return;

  const to = items[items.length - 1].to;
  const topicId = items[items.length - 1].topicId;
  const text = items.map((i) => i.text).join('\n');
  const settings = await getSettings(pool, config);

  // AI reply. The bot is given the base pack, the lead's own service pack, any
  // packs the conversation has previously pulled in, and any pack whose name or
  // keywords match the text of this message. It can also ask for one more pack
  // by name from the catalog, in which case we pull it in and call back once.
  const packs = await assemblePacks(pool, conversationId, topicId, text);
  let decision;
  let aiSucceeded = false;
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
      await setLastTopicId(pool, conversationId, decision.requestedPackIds[decision.requestedPackIds.length - 1]);
      decision = await buildReply(pool, ai, settings, conversationId, {
        packs: [...packs, ...decision.requestedPackIds],
        faqBudgetTokens: config.faqBudgetTokens,
        allowPackRequests: false,
      });
    }
    const aiMs = Date.now() - aiStart;
    recordAiSuccess(aiMs);
    aiSucceeded = true;
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

  // Carried into the next reply's prompt as a running anchor for which
  // language the conversation is in, so the model has a memory of it instead
  // of re-guessing from a limited history window every single turn.
  if (decision?.replyLanguage) {
    await setReplyLanguage(pool, conversationId, decision.replyLanguage);
  }
  // Explicit language lock from the AI (customer asked to switch languages).
  // Tri-state: a string sets it, null clears it, undefined leaves it alone.
  if (decision?.languageLock !== undefined) {
    await setLockedLanguage(pool, conversationId, decision.languageLock);
  }

  // Only marked once the model has genuinely had a turn to introduce itself -
  // the canned fallback message never mentions the bot's name, so a run where
  // the AI was down should not burn the one chance to do this for real.
  if (aiSucceeded) {
    await markIntroduced(pool, conversationId);
  }
  if (decision?.leadProfile) {
    await setLeadProfile(pool, conversationId, decision.leadProfile);
  }

  // The AI decided the other side is another automated system, not a real
  // customer. Silently mark the conversation as a peer bot and drop it. No
  // reply, no drip, no notification, no push - the team does not need to be
  // pinged about every auto-responder that sprays messages at the number.
  if (decision?.markBot) {
    await markConversationAsPeerBot(pool, conversationId, decision.reason);
    await cancelDrips(pool, conversationId);
    log.info({ conversationId, reason: decision.reason }, 'ai marked peer as automated, conversation blocked silently');
    return;
  }

  // The AI decided this needs a person.
  if (decision?.handoff) {
    const reason = decision.reason || 'The ai judged this needs a person';
    const reasonCategory = categorizeHandoffReason(reason);

    // Qualification gate: before any AI-driven handoff clears, the lead must
    // have actually told us their business AND their specific requirement
    // (see isLeadQualifiedEnough). Complaint handoffs bypass (a real issue
    // does not wait), and an AI-outage synthetic handoff bypasses (the model
    // was not the one deciding). Everything else is downgraded: we discard
    // the handoff flag, send the AI's own reply as a plain answer, keep
    // state at bot, and let the next turn try again. The prompt is where
    // the real work gets done - this gate is a thin safety net.
    const canBypassGate = !aiSucceeded || reasonCategory === 'complaint';
    if (!canBypassGate && !(await isLeadQualifiedEnough(pool, conversationId))) {
      log.info(
        { conversationId, reason, reasonCategory, parseFailed: decision.parseFailed === true },
        'ai wanted to hand off but lead is not qualified yet, treating as a plain answer',
      );
      // Pick the fallback text carefully. If the AI returned a reply, use
      // that. If not, we're in one of two cases:
      //  (a) parseFailed = the AI returned unparseable output and
      //      parseDecision defaulted to handoff:true. Using
      //      settings.fallbackMessage ("someone will get back to you")
      //      here would lie - we are NOT handing off. Use a neutral
      //      "one sec" line so the chat stays open and the next turn
      //      can produce a real reply.
      //  (b) The AI genuinely returned handoff with empty reply text.
      //      Use settings.fallbackMessage - the admin configured it for
      //      exactly this situation.
      let holding;
      if (decision.reply && decision.reply.trim()) {
        holding = decision.reply.trim();
      } else if (decision.parseFailed) {
        holding = 'One moment, let me check and come right back to you.';
      } else {
        holding = settings.fallbackMessage;
      }
      const holdingSent = await sendAndRecord(deps, to, conversationId, holding);
      if (holdingSent && !(await isContactOptedOut(pool, conversationId))) {
        const dripSteps = await resolveDripSteps(pool, settings, packs);
        await scheduleDrips(pool, conversationId, dripSteps);
      }
      // The AI gave us nothing usable (parseFailed) and the lead is not
      // qualified so we did not hand off either. Park a retry so the
      // scheduler takes another swing in a few minutes - if the next
      // attempt is clean we can finally reply for real.
      if (decision.parseFailed) {
        await scheduleRetry(pool, conversationId);
      }
      return;
    }

    await handToPending(pool, conversationId, reason);
    await recordHandoff(pool, { conversationId, source: 'ai', reason, reasonCategory, topicId });
    await cancelDrips(pool, conversationId);
    log.info({ conversationId, reason, reasonCategory }, 'ai queued conversation for a human');
    await sendAndRecord(deps, to, conversationId, decision.reply || settings.handoffMessage);
    // Suppress the push when this is a synthetic handoff from an AI
    // outage - otherwise a provider blip during a busy hour spams every
    // subscribed device with one push per inbound message. The state
    // change to pending still makes the chat visible in the console.
    if (aiSucceeded) {
      await pushHandoff(pool, conversationId, reason, log);
    } else {
      log.info({ conversationId }, 'handoff was synthesised from an ai outage, skipping push');
    }
    return;
  }

  if (decision?.block) {
    const reply = decision.reply || 'This conversation has been closed.';
    await sendAndRecord(deps, to, conversationId, reply);
    await setConversationBlocked(pool, conversationId, true);
    await cancelDrips(pool, conversationId);
    log.info({ conversationId, reason: decision.reason }, 'ai blocked conversation');
    return;
  }

  if (decision?.optOut) {
    const reply = decision.reply || settings.optOutMessage;
    await sendAndRecord(deps, to, conversationId, reply);
    await optOutContact(pool, conversationId);
    log.info({ conversationId }, 'ai honoured an opt-out request, drips cancelled');
    return;
  }

  if (decision?.reactEmoji) {
    const targetWamid = items[items.length - 1]?.wamid;
    if (targetWamid) await maybeSendReaction(deps, conversationId, to, targetWamid, decision.reactEmoji);
  }

  // A reaction alone was a complete response - nothing left to send.
  if (!decision?.reply && decision?.reactEmoji) return;

  const reply = decision?.reply || settings.fallbackMessage;
  const usedFallback = !decision?.reply;
  const sent = await sendAndRecord(deps, to, conversationId, reply);
  // If we fell through to the configured fallback message because the AI
  // did not give us a real reply, schedule a retry so the scheduler can
  // run the model one more time in a few minutes rather than leaving the
  // lead with a stale "one moment" and nothing after.
  if (sent && usedFallback) {
    await scheduleRetry(pool, conversationId);
  }
  if (sent && decision?.sendMediaId) {
    await maybeSendMedia(deps, conversationId, to, decision.sendMediaId);
  }
  if (sent && decision?.sendPaymentLinkId) {
    await maybeSendPaymentLink(deps, conversationId, to, decision.sendPaymentLinkId);
  }
  if (sent && decision?.sendHostedLinkId) {
    await maybeSendHostedLink(deps, conversationId, to, decision.sendHostedLinkId);
  }

  if (sent && decision?.paymentClaimed) {
    await recordPaymentClaimed(pool, conversationId);
    await pushHandoff(pool, conversationId, 'Says they have completed a payment.', log, { kind: 'payment_claimed' });
  }

  if (sent && !(await isContactOptedOut(pool, conversationId))) {
    const dripSteps = await resolveDripSteps(pool, settings, packs);
    await scheduleDrips(pool, conversationId, dripSteps);
  }
}

// Picks the drip sequence to schedule: the specific service pack in play for
// this reply, if it has its own follow ups configured, otherwise the general
// sequence from settings. packs[0] is always 'base', so the first numeric
// entry (if any) is the most relevant service topic for this conversation.
async function resolveDripSteps(pool, settings, packs) {
  const topicId = packs.find((p) => p !== 'base');
  if (topicId != null) {
    const topic = await getTopic(pool, topicId);
    if (topic?.drip_steps) return parseDripSteps(topic.drip_steps);
  }
  return settings.dripSteps;
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
  if (keyword.length > 0) {
    await addActivePackIds(pool, conversationId, keyword);
    await setLastTopicId(pool, conversationId, keyword[keyword.length - 1]);
  }

  return packs;
}

// Sends the file the model chose from the media catalog it was shown, as part
// of its reply. The cooldown is a backstop against a model mistake - the
// model itself is already told what it recently sent and asked not to resend
// it, this just makes sure that holds even if it slips.
export async function maybeSendMedia(deps, conversationId, to, mediaAssetId) {
  const { pool, meta, realtime, log, config } = deps;
  try {
    const asset = await getMediaAsset(pool, mediaAssetId);
    if (!asset) return;

    const recently = await wasMediaSentRecently(pool, conversationId, asset.id, config.mediaResendCooldownMinutes);
    if (recently) return;

    const { wamid, waId } = await meta.sendMedia(to, asset.kind, {
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
      await reconcileContactWaId(pool, conversationId, waId);
      realtime?.emit({ type: 'refresh', conversationId });
    }
  } catch (err) {
    log.warn({ conversationId, mediaAssetId, err }, 'failed to send media attachment');
  }
}

// Sends the payment link the model chose, as a short follow up to its reply.
// Just a plain text send - there is nothing to upload, no cooldown to check,
// a lead is free to ask for the same link again (e.g. they lost it).
export async function maybeSendPaymentLink(deps, conversationId, to, paymentLinkId) {
  const { pool, meta, realtime, log } = deps;
  try {
    const link = await getPaymentLink(pool, paymentLinkId);
    if (!link) return;

    const body = `${link.label}${link.amount_inr ? ` - ₹${link.amount_inr}` : ''}\n${link.url}`;
    const { wamid, waId } = await meta.sendText(to, body);
    if (wamid) {
      await recordOutbound(pool, { conversationId, waMessageId: wamid, body });
      await reconcileContactWaId(pool, conversationId, waId);
      realtime?.emit({ type: 'refresh', conversationId });
    }
  } catch (err) {
    log.warn({ conversationId, paymentLinkId, err }, 'failed to send payment link');
  }
}

// Sends the hosted link the model chose (a demo reel URL, a portfolio page,
// a rolling gallery hosted elsewhere) as a short follow up to the reply.
// Same plain-text-send shape as payment links: WhatsApp renders the URL as a
// tappable preview on the lead's phone, no upload step.
export async function maybeSendHostedLink(deps, conversationId, to, hostedLinkId) {
  const { pool, meta, realtime, log } = deps;
  try {
    const link = await getHostedLink(pool, hostedLinkId);
    if (!link) return;

    const body = `${link.label}\n${link.url}`;
    const { wamid, waId } = await meta.sendText(to, body);
    if (wamid) {
      await recordOutbound(pool, { conversationId, waMessageId: wamid, body });
      await reconcileContactWaId(pool, conversationId, waId);
      realtime?.emit({ type: 'refresh', conversationId });
    }
  } catch (err) {
    log.warn({ conversationId, hostedLinkId, err }, 'failed to send hosted link');
  }
}

// Reacts to the customer's message instead of, or alongside, a text reply -
// a genuine WhatsApp reaction, not a message that says "👍".
export async function maybeSendReaction(deps, conversationId, to, wamid, emoji) {
  const { pool, meta, realtime, log } = deps;
  try {
    const { wamid: sentWamid, waId } = await meta.sendReaction(to, wamid, emoji);
    if (sentWamid) {
      await recordOutbound(pool, {
        conversationId,
        waMessageId: sentWamid,
        type: 'reaction',
        reaction: { messageId: wamid, emoji },
      });
      await reconcileContactWaId(pool, conversationId, waId);
      realtime?.emit({ type: 'refresh', conversationId });
    }
  } catch (err) {
    log.warn({ conversationId, wamid, err }, 'failed to send ai reaction');
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
    const { wamid, waId } = await meta.sendText(to, body);
    const metaMs = Date.now() - metaStart;
    recordMetaLatency(metaMs);

    if (wamid) {
      await recordOutbound(pool, { conversationId, waMessageId: wamid, body, aiMs, metaMs });
      await reconcileContactWaId(pool, conversationId, waId);
      realtime?.emit({ type: 'refresh', conversationId });
    }
    log.info({ conversationId, metaMs }, 'reply sent to meta');
    return true;
  } catch (err) {
    log.error({ conversationId, to, err }, 'failed to send reply');
    return false;
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

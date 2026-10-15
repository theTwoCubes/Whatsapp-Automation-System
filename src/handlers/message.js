import {
  recordInbound,
  recordOutbound,
  recordHandoff,
  updateStatus,
  scheduleDrips,
  cancelDrips,
  getConversationState,
  getRecordedService,
  setRecordedService,
  getRecentOutboundBodies,
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
  optOutContact,
  isContactOptedOut,
  recordPaymentClaimed,
  markConversationAsPeerBot,
  recentOutboundStats,
  isLeadQualifiedEnough,
  scheduleRetry,
} from '../db/repo.js';
import { buildReply, categorizeHandoffReason } from '../ai/reply.js';
import {
  findPaymentAssertions,
  redactPaymentAssertions,
  isRepeatOf,
  resolveService,
  validateLeadProfile,
} from '../ai/reconcile.js';
import { recordWebhook, recordAiSuccess, recordAiError, recordMetaLatency } from '../ai/telemetry.js';
import { getTopic, listTopics, resolveTopicByServiceName } from '../knowledge/topics.js';
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

// The deterministic opt-out net, and it is deliberately as small as it can
// be. Judging whether someone wants to stop hearing from us is a reading
// comprehension problem and belongs to the AI's own "opt_out" action, which
// handles every phrasing and every language. "my clients usually unsubscribe
// from my promotions" is a sentence about their business, not a request.
//
// What stays here is the case where the entire message is a bare opt-out
// command and nothing else. Nobody sends a message consisting only of the
// word "STOP" to mean anything other than stop. This exists for one reason:
// honouring an opt-out is a compliance obligation that cannot depend on an
// API call succeeding, so there has to be a path that works when the model is
// unreachable.
//
// Phrases were removed from this list, not added to it. "please stop" used to
// be here and matched a customer saying "please stop asking me so many
// questions", which is a complaint about the conversation, not a request to
// never be contacted again.
const OPT_OUT_PATTERNS = [
  /^stop$/i,
  /^unsubscribe$/i,
  /^unsub$/i,
  /^opt.?out$/i,
  /^remove me$/i,
];

export function isOptOutRequest(text) {
  const trimmed = (text || '').trim().replace(/[.!]+$/, '');
  return OPT_OUT_PATTERNS.some((re) => re.test(trimmed));
}

// Looser: "this might be an opt-out". Never acts on its own - it is only
// consulted when the AI is unreachable, where guessing either way is wrong.
// A lead who may have just asked us to stop must not be guessed at, and must
// not be ignored either, so the conversation goes to a person instead.
const MAYBE_OPT_OUT = /\b(?:unsubscribe|opt\s?out|remove me|stop (?:messaging|texting|contacting)|don'?t (?:message|text|contact) me|band karo|mat bhejo|message mat)\b/i;

export function looksLikeOptOut(text) {
  return MAYBE_OPT_OUT.test(String(text || ''));
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

  // A file the lead sends goes through the same AI pipeline as text. What the
  // bot is told is simply THAT a file arrived and of what kind - nothing reads
  // the file itself. That is a deliberate trade: the fact of arrival is known
  // for certain and instantly, so acknowledging it can never be wrong and
  // never be late. Guessing at the contents meant the acknowledgement waited
  // on an API call, and when that call was slow the bot answered without it
  // and asked the lead to send a file they had already sent.
  //
  // Caption text, if the lead attached any, is their actual words and is used
  // as the message text with the file noted alongside it.
  // The prompt learns about the file from the conversation history, which now
  // includes file messages whether or not they carry a caption (see
  // historyBody in ai/reply.js). What is needed here is only a non-empty
  // label, so the batch has something to carry.
  if (!effectiveText) {
    // Location, a contact card, an order, a system notice: these carry no
    // file, and what they are is already known, so the plain description is
    // the most the bot needs.
    effectiveText = describeInboundBody(message, quickReplyText) ?? `Sent a ${message.type}`;
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

  // Claimed before the reply starts and released when it is finished, so
  // anything the lead sends while this reply is being written waits and joins
  // the next batch instead of earning its own reply a few seconds later.
  const doneReplying = getBatcher(config).beginReply(result.conversationId);
  try {
    await respondToLead(deps, result.conversationId, items);
  } finally {
    doneReplying();
  }
}

// Cheap defensive check before every AI call: if we've sent a lot of bot
// replies to this contact in a short window and still know nothing about who
// they are, the other side is almost certainly automated. Silently mark it
// as a peer bot and skip the AI call entirely, so a stuck loop caps at
// whatever the threshold is instead of eating the API bill.
const PEER_BOT_LOOP_MAX_REPLIES = 6;

// The unconditional ceiling, separate from the peer-bot net above because it
// applies to real leads too. Generous enough that a genuinely chatty exchange
// never touches it - a real customer and a real salesperson do not trade
// twelve messages in five minutes - and low enough that any runaway stops
// being the customer's problem quickly.
const REPLY_CAP_WINDOW_MIN = 5;
const REPLY_CAP_MAX = 12;
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

  // A blunt ceiling on how fast this conversation can be replied to, whatever
  // else goes wrong. Every other guard here is specific - this one does not
  // care why. It is the difference between a bug being embarrassing and a bug
  // sending a lead forty messages before anyone notices.
  const { recentOutbound } = await recentOutboundStats(pool, conversationId, REPLY_CAP_WINDOW_MIN);
  if (recentOutbound >= REPLY_CAP_MAX) {
    log.warn(
      { conversationId, recentOutbound, windowMinutes: REPLY_CAP_WINDOW_MIN },
      'reply cap reached for this conversation, sending nothing until the window clears',
    );
    return;
  }

  const to = items[items.length - 1].to;
  const topicId = items[items.length - 1].topicId;
  const text = items.map((i) => i.text).join('\n');
  const settings = await getSettings(pool, config);

  // Every active service's answers go in - see assemblePacks.
  const packs = await assemblePacks(pool, conversationId, topicId);
  let decision;
  let aiSucceeded = false;
  let repeatedAfterRetry = false;
  const aiStart = Date.now();
  try {
    decision = await buildReply(pool, ai, settings, conversationId, {
      packs,
      faqBudgetTokens: config.faqBudgetTokens,
      log,
    });
    await applyServiceDecision(pool, conversationId, decision, log);

    // The model wrote its previous message again - word for word, or reworded
    // into the same turn twice, which is what the client kept seeing. Show it
    // what it just tried to say and give it one more go.
    //
    // Only plain answers go through this. A handoff, block, opt out or
    // peer-bot call is a state change that has to land, and the reply text
    // attached to it is often a fixed line that legitimately repeats - those
    // must never be held back over how the message reads.
    const plainAnswer = !decision?.handoff && !decision?.block && !decision?.optOut && !decision?.markBot;
    const previousReplies = await getRecentOutboundBodies(pool, conversationId, 3);
    const repeat = plainAnswer && decision?.reply ? isRepeatOf(decision.reply, previousReplies) : null;
    if (repeat) {
      log.warn({ conversationId, similarity: Number(repeat.score.toFixed(2)) }, 'ai repeated a reply it has already sent, retrying once');
      const retry = await buildReply(pool, ai, settings, conversationId, {
        packs,
        faqBudgetTokens: config.faqBudgetTokens,
        avoidRepeating: repeat.previous,
        log,
      });
      // A retry that came back as a handoff (or any other state change) is
      // taken as-is: the model changing its mind about what this turn needs
      // outranks the repeat it was asked to fix.
      const stateChange = retry?.handoff || retry?.block || retry?.optOut || retry?.markBot;
      if (retry?.reply && (stateChange || !isRepeatOf(retry.reply, previousReplies))) {
        decision = retry;
      } else {
        // The model was shown its own repeat, told to write something
        // different, and produced the same thing again. Send nothing: the
        // same message arriving twice in a row is the single most visible way
        // this looks broken to a customer, and silence here is recoverable -
        // their next message gets a fresh turn, and the drip still goes out
        // if they go quiet.
        //
        // Deliberately narrow. A repeat is only ever suppressed once the
        // model has refused an explicit correction, so a lead who genuinely
        // asks the same question twice in a row still gets their answer.
        log.warn({ conversationId }, 'ai repeated itself again after being corrected, sending nothing this turn');
        repeatedAfterRetry = true;
      }
    }

    // Nothing here can see a payment, so nothing here may claim one arrived.
    // The model is asked once to say it differently and, if it will not, the
    // sentence is replaced outright - this is the one invariant where being
    // wrong costs the client real money and real trust.
    if (decision?.reply) {
      const claims = findPaymentAssertions(decision.reply);
      if (claims.length > 0) {
        log.warn({ conversationId, claims }, 'ai claimed a payment was received, retrying once');
        const retry = await buildReply(pool, ai, settings, conversationId, {
          packs,
          faqBudgetTokens: config.faqBudgetTokens,
          avoidClaimingPayment: claims,
          log,
        });
        if (retry?.reply && findPaymentAssertions(retry.reply).length === 0) {
          decision = { ...retry, paymentClaimed: decision.paymentClaimed || retry.paymentClaimed };
        } else {
          const safe = redactPaymentAssertions(decision.reply, decision.replyLanguage);
          log.warn(
            { conversationId, redacted: safe.redacted },
            'ai insisted on confirming a payment it cannot see, rewrote the reply',
          );
          decision = { ...decision, reply: safe.text };
        }
      }
    }

    const aiMs = Date.now() - aiStart;
    recordAiSuccess(aiMs);
    aiSucceeded = true;
    // Which provider answered is worth logging: buildReply already knows, and
    // without it there is no way to confirm from the outside that switching
    // provider in the console actually took effect, or to notice that the
    // primary is quietly erroring and the failover is carrying every reply.
    log.info(
      {
        conversationId,
        aiMs,
        handoff: decision?.handoff,
        provider: decision?.aiProvider,
        failedOver: decision?.aiProviderFallback?.length ? decision.aiProviderFallback : undefined,
      },
      'ai reply built',
    );
  } catch (err) {
    const aiMs = Date.now() - aiStart;
    recordAiError();
    log.warn({ conversationId, aiMs, err }, 'ai reply unavailable, using fallback');
    // A message that might be an opt-out, arriving while the model is down,
    // is the one case where neither guess is acceptable: honour it wrongly
    // and a real lead is silently dropped; ignore it wrongly and we keep
    // messaging someone who asked us to stop, which is a compliance problem.
    // So it goes to a person, flagged, and no follow ups are scheduled.
    const maybeOptOut = looksLikeOptOut(text);
    decision = {
      handoff: true,
      reason: maybeOptOut
        ? 'AI unavailable and this message may be a request to stop contacting them - please read it and opt them out if so'
        : 'AI service unavailable',
      reply: settings.fallbackMessage,
    };
    if (maybeOptOut) {
      log.warn({ conversationId }, 'possible opt-out arrived while the ai was unavailable, handing to a person rather than guessing');
      await cancelDrips(pool, conversationId);
    }
  }

  // Nothing worth sending this turn (see the loop guard above). A follow up
  // is still scheduled so a lead who now goes quiet is not simply dropped.
  if (repeatedAfterRetry) {
    if (!(await isContactOptedOut(pool, conversationId))) {
      await scheduleDrips(pool, conversationId, await resolveDripSteps(pool, conversationId, settings));
    }
    return;
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
  // Validated before it is stored. A field that looks filled and says nothing
  // is worse than an empty one: it reads as complete to the qualification gate
  // and as useless to the person who picks the lead up. "For my business"
  // became lead_business = "business", which satisfied the gate on nothing.
  await storeLeadProfile(pool, conversationId, decision?.leadProfile, log);

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
        const dripSteps = await resolveDripSteps(pool, conversationId, settings);
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
    const dripSteps = await resolveDripSteps(pool, conversationId, settings);
    await scheduleDrips(pool, conversationId, dripSteps);
  }
}

// Picks the drip sequence to schedule: the lead's service if it has its own
// follow ups configured, otherwise the general sequence from settings.
//
// The conversation's recorded service is checked first, before the packs in
// play for this reply. It is the one the console shows for this lead and the
// one a per-service follow up is configured against. Every service's pack is
// now loaded on every turn, so the pack list alone cannot say which service a
// follow up belongs to - the recorded service is the only thing that can.
async function resolveDripSteps(pool, conversationId, settings) {
  // Only the recorded service, and nothing else. This used to fall back to
  // scanning the packs in play, which was harmless while packs were selected
  // per message but is actively wrong now that every service is loaded on
  // every turn: it would have sent a lead with no recorded service whichever
  // service's follow ups happened to sort first.
  const recorded = (await getRecordedService(pool, conversationId)).topicId;
  if (recorded != null) {
    const topic = await getTopic(pool, recorded);
    if (topic?.drip_steps) return parseDripSteps(topic.drip_steps);
  }
  return settings.dripSteps;
}

// The packs going into this reply. Every active service's answers go in, not
// a selected subset: for this client all of them together come to well under
// the token budget, and the entire category of bug where the bot answered
// from the wrong service's pack came from trying to choose. There is nothing
// to get wrong if it can see all of them.
//
// Order is what matters now, because order decides which entries survive if
// the budget ever is exceeded: base, then the service this conversation is
// actually about, then its campaign, then everything else. Entries marked
// pinned are never dropped regardless.
//
// Keyword matching used to both load packs AND decide which service the lead
// was filed under. It no longer does either. It could only see literal words,
// so "need logo design for scientific" scored the plain Logo Design pack and
// the Scientific one equally and the tie went to whichever came first in the
// table - which is how a ₹50,004 lead was quoted ₹20,000. Deciding the
// service is now the model's job, held to the rules in src/ai/reconcile.js.
// Files the conversation under a service, or declines to. The model proposes;
// resolveService decides, and the rules it applies are the ones the client
// asked for: a guess never overwrites a certainty, and a service the customer
// mentions in passing never replaces the one they are actually here for.
// Validated before it is stored. A field that looks filled and says nothing
// is worse than an empty one: it reads as complete to the qualification gate
// and as useless to the person who picks the lead up. "For my business"
// became lead_business = "business", which satisfied the gate on nothing.
export async function storeLeadProfile(pool, conversationId, leadProfile, log) {
  if (!leadProfile) return;
  const services = (await listTopics(pool)).map((t) => t.name).filter(Boolean);
  const checked = validateLeadProfile(flattenLeadProfile(leadProfile), { serviceNames: services });
  if (checked.rejected.length > 0) {
    log?.warn?.({ conversationId, rejected: checked.rejected }, 'discarded lead fields that do not say anything');
  }
  if (checked.profile) {
    await setLeadProfile(pool, conversationId, unflattenLeadProfile(checked.profile));
  }
}

// setLeadProfile takes { name, business, email, address, details: {...} }
// while the validator works on one flat set of fields, since "says nothing"
// is the same question whether the field lives on the contact row or inside
// lead_details. These two convert between the shapes.
function flattenLeadProfile(profile) {
  return {
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.business ? { business: profile.business } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.address ? { address: profile.address } : {}),
    ...(profile.details ?? {}),
  };
}

function unflattenLeadProfile(flat) {
  const { name, business, email, address, ...details } = flat;
  return {
    name: name ?? null,
    business: business ?? null,
    email: email ?? null,
    address: address ?? null,
    details,
  };
}

// Files the conversation under a service, or declines to. The model proposes;
// resolveService decides, and the rules it applies are the ones the client
// asked for: a guess never overwrites a certainty, and a service the customer
// mentions in passing never replaces the one they are actually here for.
export async function applyServiceDecision(pool, conversationId, decision, log) {
  if (!decision?.leadService) return;

  const topic = await resolveTopicByServiceName(pool, decision.leadService);
  if (!topic) {
    log.info(
      { conversationId, leadService: decision.leadService },
      'ai named a service that matches no topic, leaving the recorded service alone',
    );
    return;
  }

  const recorded = await getRecordedService(pool, conversationId);
  const outcome = resolveService({
    current: recorded.topicId == null ? null : String(recorded.topicId),
    currentBasis: recorded.basis ?? 'unset',
    proposed: String(topic.id),
    proposedBasis: decision.serviceBasis ?? 'inferred',
    isChange: decision.serviceChange === true,
  });

  if (outcome.changed || outcome.basis !== recorded.basis) {
    await setRecordedService(pool, conversationId, Number(outcome.service), outcome.basis);
    log.info(
      { conversationId, service: outcome.service, basis: outcome.basis, why: outcome.why },
      'recorded service updated',
    );
  } else if (outcome.why === 'passing mention, not a switch') {
    log.info(
      { conversationId, mentioned: topic.name, recorded: recorded.topicId },
      'ai mentioned another service but did not call it a switch, service left as it was',
    );
  }
}

export async function assemblePacks(pool, conversationId, campaignTopicId) {
  const packs = ['base'];
  const seen = new Set();
  const add = (id) => {
    const key = String(id);
    if (id != null && !seen.has(key)) {
      seen.add(key);
      packs.push(Number(id));
    }
  };

  const recorded = await getRecordedService(pool, conversationId);
  add(recorded.topicId);
  if (campaignTopicId) add(campaignTopicId);
  for (const topic of await listTopics(pool)) {
    if (topic.active && Number(topic.faq_count) > 0) add(topic.id);
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

    // The note, when the service has one, always rides underneath the url in
    // the same message - it is the "what to do next" the client wants every
    // payer to see, so it is not left to the model to remember.
    const note = (link.note ?? '').trim();
    const body =
      `${link.label}${link.amount_inr ? ` - ₹${link.amount_inr}` : ''}\n${link.url}` +
      (note ? `\n\n${note}` : '');
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

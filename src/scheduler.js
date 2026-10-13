import {
  claimDueDrips, markDrip, markDripStuck, reclaimStuckDrips, recordOutbound, conversationsToResume,
  getActivePackIds, purgeDeletedConversations, recordHandoff, cancelDrips, setConversationBlocked, setReplyLanguage, setLockedLanguage,
  setLeadProfile, markIntroduced, reconcileContactWaId,
  claimBulkSendJobs, markBulkSendJob, reclaimStuckBulkSendJobs, findOrCreateComposeConversation,
  optOutContact,
  recordPaymentClaimed,
  isLeadQualifiedEnough,
  conversationsDueForRetry,
  clearRetryAt,
  latestMessageId,
  getConversationState,
  setLastTopicId,
} from './db/repo.js';
import { resolveTopicByServiceName } from './knowledge/topics.js';
import { handToBot, handToPending } from './handoff.js';
import { buildReply, categorizeHandoffReason } from './ai/reply.js';
import { getSettings } from './settings.js';
import { getRefinementCursor, runWeeklyRefinement } from './knowledge/refinement.js';
import { pushHandoff, maybeSendMedia, maybeSendPaymentLink, maybeSendReaction } from './handlers/message.js';
import { MetaApiError } from './meta/client.js';

// Runs the recurring background work: drip follow ups, the auto resume that
// hands stalled chats back to the bot, and the weekly learning pass. In
// process on an interval, single instance is fine for now.
export function startScheduler(deps, intervalMs = 60000) {
  let lastPurgeAt = 0;
  const tick = async () => {
    try {
      await runDueDrips(deps);
      await runAutoResume(deps);
      await runBulkSend(deps);
      await runRetryAttempts(deps);
      await runWeeklyRefinementIfDue(deps);
      // Hard-delete soft-deleted chats past their grace period, at most once
      // an hour so the delete query is not run on every minute tick.
      if (Date.now() - lastPurgeAt > 3600_000) {
        lastPurgeAt = Date.now();
        const purged = await purgeDeletedConversations(deps.pool, 30);
        if (purged > 0) deps.log.info({ purged }, 'purged soft-deleted conversations');
      }
    } catch (err) {
      deps.log.error({ err }, 'scheduler tick failed');
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runDueDrips(deps) {
  const { pool, meta, config, log } = deps;
  const settings = await getSettings(pool, config);

  // A job stuck in 'sending' means the process that claimed it died before
  // it ever heard back from Meta - safe to hand back out.
  const reclaimed = await reclaimStuckDrips(pool, 15);
  if (reclaimed.length > 0) log.warn({ jobIds: reclaimed }, 'reclaimed drip jobs abandoned mid-send');

  const jobs = await claimDueDrips(pool, 20);

  for (const job of jobs) {
    let delivered = false;
    try {
      const components = buildDripComponents(job, log);
      const { wamid, waId } = await meta.sendTemplate(job.wa_id, job.template_name, settings.dripLanguage, components);
      delivered = true;
      await markDrip(pool, job.id, 'sent');
      if (wamid) {
        await recordOutbound(pool, {
          conversationId: job.conversation_id,
          waMessageId: wamid,
          type: 'template',
          body: `[template] ${job.template_name}`,
        });
        await reconcileContactWaId(pool, job.conversation_id, waId);
      }
      log.info({ jobId: job.id, step: job.step, to: job.wa_id }, 'drip template sent');
    } catch (err) {
      if (delivered) {
        // Meta already confirmed delivery - marking this 'failed' would let
        // it get retried and double message the lead. Leave it for a human.
        try {
          await markDripStuck(pool, job.id);
        } catch (markErr) {
          log.error({ jobId: job.id, markErr }, 'failed to even mark a delivered drip stuck');
        }
        log.error({ jobId: job.id, err }, 'drip delivered but failed to record - needs manual follow up, not auto retried');
      } else {
        await markDrip(pool, job.id, 'failed');
        log.error({ jobId: job.id, err }, 'drip send failed');
      }
    }
  }

  return jobs.length;
}

// Sends a batch of xlsx-uploaded leads their opening template message, a few
// at a time per tick so a list of hundreds does not slam Meta all at once and
// so a crash mid-run loses nothing - exactly the same shape as runDueDrips,
// just against bulk_send_jobs instead of drip_jobs.
export async function runBulkSend(deps) {
  const { pool, meta, config, log } = deps;

  const reclaimed = await reclaimStuckBulkSendJobs(pool, 15);
  if (reclaimed.length > 0) log.warn({ jobIds: reclaimed }, 'reclaimed bulk send jobs abandoned mid-send');

  const jobs = await claimBulkSendJobs(pool, 20);

  for (const job of jobs) {
    let delivered = false;
    let conversationId = null;
    try {
      conversationId = await findOrCreateComposeConversation(pool, {
        waId: job.wa_id, name: job.name, business: job.business, email: job.email, topicId: job.topic_id,
      });
      const templateRow = await pool.query('select language from templates where name = $1 limit 1', [job.template_name]);
      const language = templateRow.rows[0]?.language || config.dripLanguage;
      const { wamid, waId } = await meta.sendTemplate(job.wa_id, job.template_name, language);
      delivered = true;
      await markBulkSendJob(pool, job.id, 'sent', { conversationId });
      if (wamid) {
        await recordOutbound(pool, {
          conversationId,
          waMessageId: wamid,
          type: 'template',
          body: `[template] ${job.template_name}`,
        });
        // The number this lead was queued under may not be the wa_id Meta
        // actually uses for them (see reconcileContactWaId) - fixed up here,
        // right after the very first message this brand new contact ever
        // gets, before the lead has had any chance to reply under the
        // canonical id and end up as a second, separate contact.
        await reconcileContactWaId(pool, conversationId, waId);
      }
      log.info({ jobId: job.id, to: job.wa_id }, 'bulk send template sent');
    } catch (err) {
      if (delivered) {
        // Meta already confirmed delivery - marking this 'failed' would let
        // it get retried and double message the lead. Leave it for a human.
        try {
          await markBulkSendJob(pool, job.id, 'stuck', { conversationId });
        } catch (markErr) {
          log.error({ jobId: job.id, markErr }, 'failed to even mark a delivered bulk send stuck');
        }
        log.error({ jobId: job.id, err }, 'bulk send delivered but failed to record - needs manual follow up, not auto retried');
      } else {
        const message = err instanceof MetaApiError ? err.message : (err?.message || 'send failed');
        await markBulkSendJob(pool, job.id, 'failed', { error: message, conversationId });
        log.error({ jobId: job.id, err }, 'bulk send failed');
      }
    }
  }

  return jobs.length;
}

// Builds the header component for a drip's template message when a media
// asset is attached to the step. Reuses the same Meta media id already
// uploaded for regular sends - no separate upload needed. Template headers
// only support document, image, or video, so anything else (audio) is
// skipped with a warning rather than sent with a mismatched header.
function buildDripComponents(job, log) {
  if (!job.media_asset_id || !job.meta_media_id) return undefined;
  if (!['document', 'image', 'video'].includes(job.media_kind)) {
    log.warn({ jobId: job.id, kind: job.media_kind }, 'drip media kind cannot be used as a template header, sending without it');
    return undefined;
  }
  const media = { id: job.meta_media_id };
  if (job.media_kind === 'document' && job.media_filename) media.filename = job.media_filename;
  return [{ type: 'header', parameters: [{ type: job.media_kind, [job.media_kind]: media }] }];
}

// Hands chats back to the bot when a human has left the lead waiting too long,
// then answers the waiting message so the lead is not left hanging.
export async function runAutoResume(deps) {
  const { pool, meta, ai, config, realtime, log } = deps;
  const settings = await getSettings(pool, config);
  if (!settings.resumeMinutes || settings.resumeMinutes <= 0) return 0;

  const rows = await conversationsToResume(pool, settings.resumeMinutes);
  for (const row of rows) {
    try {
      await handToBot(pool, row.id);
      realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
      log.info({ conversationId: row.id }, 'auto resumed conversation to the bot');
      await processResumeReplyForRow(deps, settings, row, 'auto resume');
    } catch (err) {
      log.error({ conversationId: row.id, err }, 'auto resume failed');
    }
  }
  return rows.length;
}

// Runs one buildReply pass for a conversation whose last message is an
// inbound the bot never got to answer, then dispatches on the model's decision
// with the same handoff/block/opt-out/reaction handling respondToLead uses
// live. Extracted from the runAutoResume loop so the manual "Resume bot"
// endpoint can also catch up on a pending inbound the human left unanswered.
async function processResumeReplyForRow(deps, settings, row, context, options = {}) {
  const { pool, meta, ai, config, realtime, log } = deps;
  const { silentOnStuck = false } = options;

  // Snapshot the thread before the ai call so we can tell afterwards whether
  // it moved. buildReply takes seconds, and the live webhook path does not
  // take our advisory lock - it only re-checks state - so a message arriving
  // mid-call would otherwise get two replies built against stale history.
  const messageIdBefore = await latestMessageId(pool, row.id);

  let decision;
  try {
    // Reuse whatever packs the conversation already had, plus the campaign's
    // own if any. Resume has no new message text to run keyword matching
    // against, so this is what the last live turn had.
    const sticky = await getActivePackIds(pool, row.id);
    const packs = ['base'];
    if (row.topic_id) packs.push(Number(row.topic_id));
    for (const id of sticky) if (!packs.includes(id)) packs.push(id);
    decision = await buildReply(pool, ai, settings, row.id, {
      packs,
      faqBudgetTokens: config.faqBudgetTokens,
      allowPackRequests: false,
      log,
    });
  } catch {
    // fall back below
  }

  // The thread moved while we were thinking: either a new message landed (the
  // live handler is answering it with fresher context than ours) or an agent
  // took the chat. Either way this decision is stale - drop it rather than
  // double-reply. Checked before any write so a discarded turn leaves no
  // trace on the conversation.
  const messageIdAfter = await latestMessageId(pool, row.id);
  if (messageIdAfter !== messageIdBefore) {
    log?.info(
      { conversationId: row.id, messageIdBefore, messageIdAfter },
      `${context}: a new message landed during the ai call, dropping this stale reply`,
    );
    return;
  }
  const stateNow = await getConversationState(pool, row.id);
  if (stateNow !== 'bot') {
    log?.info(
      { conversationId: row.id, state: stateNow },
      `${context}: conversation left the bot during the ai call, dropping this reply`,
    );
    return;
  }

  if (decision?.replyLanguage) {
    await setReplyLanguage(pool, row.id, decision.replyLanguage);
  }
  if (decision?.languageLock !== undefined) {
    await setLockedLanguage(pool, row.id, decision.languageLock);
  }
  if (decision) {
    await markIntroduced(pool, row.id);
  }
  if (decision?.leadProfile) {
    await setLeadProfile(pool, row.id, decision.leadProfile);
  }
  // Same as respondToLead: the model's own read of the service wins over the
  // keyword guess, and an unrecognised name is ignored rather than applied.
  if (decision?.leadService) {
    const topic = await resolveTopicByServiceName(pool, decision.leadService);
    if (topic) await setLastTopicId(pool, row.id, topic.id);
  }

  // Mirrors respondToLead in handlers/message.js - the model's decision here
  // carries exactly the same handoff/block/reaction meaning as it does on a
  // live message, including the qualification gate. Auto-resume and manual
  // catch-up both go through here, so an unqualified stranger cannot be
  // escalated to pending just because a human once opened the chat.
  if (decision?.handoff) {
    const reason = decision.reason || 'The ai judged this needs a person';
    const reasonCategory = categorizeHandoffReason(reason);
    const bypassGate = reasonCategory === 'complaint';
    if (!bypassGate && !(await isLeadQualifiedEnough(pool, row.id))) {
      // Retry mode: a repeat parseFailed-into-holding is the exact loop
      // we are trying to avoid. If the retry pass still has nothing real
      // to say, swallow it instead of double-sending.
      if (silentOnStuck && (decision.parseFailed || !decision.reply || !decision.reply.trim())) {
        log?.info({ conversationId: row.id, reason }, `${context}: ai still stuck on handoff downgrade, staying silent`);
        return;
      }
      log.info(
        { conversationId: row.id, reason, reasonCategory },
        `${context}: ai wanted to hand off but lead is not qualified yet, treating as a plain answer`,
      );
      const holding = decision.reply && decision.reply.trim()
        ? decision.reply.trim()
        : settings.fallbackMessage;
      const { wamid, waId } = await meta.sendText(row.wa_id, holding);
      if (wamid) {
        await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: holding });
        await reconcileContactWaId(pool, row.id, waId);
        realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
      }
      return;
    }
    await handToPending(pool, row.id, reason);
    await recordHandoff(pool, { conversationId: row.id, source: 'ai', reason, reasonCategory, topicId: row.topic_id ?? null });
    await cancelDrips(pool, row.id);
    log.info({ conversationId: row.id, reason, reasonCategory }, `${context}: ai queued conversation for a human`);
    const { wamid, waId } = await meta.sendText(row.wa_id, decision.reply || settings.handoffMessage);
    if (wamid) {
      await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: decision.reply || settings.handoffMessage });
      await reconcileContactWaId(pool, row.id, waId);
    }
    await pushHandoff(pool, row.id, reason, log);
    realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
    return;
  }

  if (decision?.block) {
    const reply = decision.reply || 'This conversation has been closed.';
    const { wamid, waId } = await meta.sendText(row.wa_id, reply);
    if (wamid) {
      await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: reply });
      await reconcileContactWaId(pool, row.id, waId);
    }
    await setConversationBlocked(pool, row.id, true);
    await cancelDrips(pool, row.id);
    log.info({ conversationId: row.id, reason: decision.reason }, `${context}: ai blocked conversation`);
    realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
    return;
  }

  if (decision?.optOut) {
    const reply = decision.reply || settings.optOutMessage;
    const { wamid, waId } = await meta.sendText(row.wa_id, reply);
    if (wamid) {
      await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: reply });
      await reconcileContactWaId(pool, row.id, waId);
    }
    await optOutContact(pool, row.id);
    log.info({ conversationId: row.id }, `${context}: ai honoured an opt-out request`);
    realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
    return;
  }

  if (decision?.reactEmoji && row.last_inbound_wamid) {
    await maybeSendReaction(deps, row.id, row.wa_id, row.last_inbound_wamid, decision.reactEmoji);
  }

  if (!decision?.reply && decision?.reactEmoji) return;

  // Retry mode: if the model is still stuck (no real reply, no action), do
  // not fire another holding message. The whole point of a scheduled retry
  // is "if a clean answer appears now, deliver it; otherwise stay quiet"
  // instead of spamming the lead with repeated "one moment" lines.
  if (silentOnStuck && (!decision || !decision.reply || decision.parseFailed)) {
    log?.info({ conversationId: row.id }, `${context}: ai still stuck, staying silent`);
    return;
  }

  const reply = decision?.reply || settings.fallbackMessage;
  const { wamid, waId } = await meta.sendText(row.wa_id, reply);
  if (wamid) {
    await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: reply });
    await reconcileContactWaId(pool, row.id, waId);
    if (decision?.sendMediaId) await maybeSendMedia(deps, row.id, row.wa_id, decision.sendMediaId);
    if (decision?.sendPaymentLinkId) await maybeSendPaymentLink(deps, row.id, row.wa_id, decision.sendPaymentLinkId);
    if (decision?.paymentClaimed) {
      await recordPaymentClaimed(pool, row.id);
      await pushHandoff(pool, row.id, 'Says they have completed a payment.', log, { kind: 'payment_claimed' });
    }
    realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
  }
}

// Picks up conversations the handler parked for a retry because the first AI
// pass left them stuck (parseFailed or empty-reply fallback). Clears retry_at
// before running so a repeated failure does not spin on every tick, takes the
// same advisory lock the webhook and manual handback use so a message arriving
// between ticks is not raced, and routes through processResumeReplyForRow with
// silentOnStuck=true so a second broken decision stays quiet instead of
// re-sending another holding line.
export async function runRetryAttempts(deps) {
  const { pool, log } = deps;
  const rows = await conversationsDueForRetry(pool, 20);
  if (rows.length === 0) return 0;
  const settings = await getSettings(pool, deps.config);
  let processed = 0;
  for (const row of rows) {
    // Advisory locks are session-scoped, and pool.query may land on a
    // different pooled connection each time, so we check out a dedicated
    // client for the whole lock/unlock pair - otherwise the unlock runs
    // on the wrong backend and the lock leaks until the connection is
    // dropped from the pool.
    const client = await pool.connect();
    try {
      const gotLock = await client.query('select pg_try_advisory_lock($1) as got', [Number(row.id)]);
      if (!gotLock.rows[0]?.got) {
        log?.info({ conversationId: row.id }, 'retry: another handler holds the lock, skipping this tick');
        continue;
      }
      try {
        // Clear retry_at before running so a stuck-again result does not get
        // picked up a second time; the handler will re-park a fresh retry if
        // it still needs one.
        await clearRetryAt(pool, row.id);
        if (row.last_direction !== 'inbound') continue;
        await processResumeReplyForRow(deps, settings, row, 'retry', { silentOnStuck: true });
        processed += 1;
      } catch (err) {
        log?.error({ conversationId: row.id, err }, 'retry attempt failed');
      } finally {
        await client.query('select pg_advisory_unlock($1)', [Number(row.id)]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }
  return processed;
}

// Manual "Resume bot" catch-up. Called after the admin flips a conversation
// back to the bot via /handback. If the last message on the thread is an
// inbound the human never replied to, the bot picks it up and answers now
// instead of waiting for the customer to nudge again. If the last message
// was outbound (the human did reply before handing back), nothing to catch
// up on and this returns without an extra send.
export async function catchUpAfterHandback(deps, conversationId) {
  const { pool, log } = deps;
  const settings = await getSettings(pool, deps.config);

  // Try to take a session-level advisory lock for this conversation. If a
  // parallel path (a webhook that fired between handback and this call, or
  // a second Resume-bot click, or an auto-resume tick) already has it, bail
  // out - that other path will produce the reply and we should not
  // double-send. A dedicated client holds the lock for its lifetime: pool
  // connections are not pinned to the caller, so lock-then-pool.query-unlock
  // would run the unlock on a different backend and leak the lock.
  const client = await pool.connect();
  const gotLock = await client.query('select pg_try_advisory_lock($1) as got', [Number(conversationId)]);
  if (!gotLock.rows[0]?.got) {
    log?.info({ conversationId }, 'handback catch-up: another handler already owns this conversation, skipping');
    client.release();
    return false;
  }

  try {
    const res = await pool.query(
      `select c.id, ct.wa_id, ca.topic_id,
         (select m.wa_message_id from messages m
          where m.conversation_id = c.id and m.direction = 'inbound'
          order by m.created_at desc, m.id desc
          limit 1) as last_inbound_wamid,
         (select direction from messages m
          where m.conversation_id = c.id
          order by m.created_at desc, m.id desc
          limit 1) as last_direction
       from conversations c
       join contacts ct on ct.id = c.contact_id
       left join campaigns ca on ca.id = c.campaign_id
       where c.id = $1 and c.state = 'bot'`,
      [conversationId],
    );
    const row = res.rows[0];
    if (!row) return false;
    // last_direction check happens after taking the lock, so an outbound
    // that landed while we were waiting for the lock (typical race: webhook
    // replied faster than us) leaves nothing to catch up on and we exit.
    if (row.last_direction !== 'inbound') return false;

    await processResumeReplyForRow(deps, settings, row, 'manual handback');
    return true;
  } catch (err) {
    log?.error({ conversationId, err }, 'manual handback catch-up failed');
    return false;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [Number(conversationId)]).catch(() => {});
    client.release();
  }
}

// Runs the weekly refinement pass once the configured interval has elapsed
// since the last run, otherwise does nothing. Checked every tick rather than
// on its own timer so there is no second interval to manage.
export async function runWeeklyRefinementIfDue(deps) {
  const { pool, ai, config, log } = deps;
  const cursor = await getRefinementCursor(pool);
  const intervalMs = (config.learningIntervalDays ?? 7) * 24 * 60 * 60 * 1000;
  if (cursor.lastRunAt && Date.now() - new Date(cursor.lastRunAt).getTime() < intervalMs) return null;

  try {
    const result = await runWeeklyRefinement(pool, ai);
    log.info(result, 'weekly refinement pass completed');
    return result;
  } catch (err) {
    log.error({ err }, 'weekly refinement pass failed');
    return null;
  }
}

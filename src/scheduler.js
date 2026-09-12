import {
  claimDueDrips, markDrip, markDripStuck, reclaimStuckDrips, recordOutbound, conversationsToResume,
  getActivePackIds, purgeDeletedConversations, recordHandoff, cancelDrips, setConversationBlocked, setReplyLanguage,
} from './db/repo.js';
import { handToBot, handToPending } from './handoff.js';
import { buildReply, categorizeHandoffReason } from './ai/reply.js';
import { getSettings } from './settings.js';
import { getRefinementCursor, runWeeklyRefinement } from './knowledge/refinement.js';
import { pushHandoff, maybeSendMedia, maybeSendReaction } from './handlers/message.js';

// Runs the recurring background work: drip follow ups, the auto resume that
// hands stalled chats back to the bot, and the weekly learning pass. In
// process on an interval, single instance is fine for now.
export function startScheduler(deps, intervalMs = 60000) {
  let lastPurgeAt = 0;
  const tick = async () => {
    try {
      await runDueDrips(deps);
      await runAutoResume(deps);
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
      const wamid = await meta.sendTemplate(job.wa_id, job.template_name, settings.dripLanguage, components);
      delivered = true;
      await markDrip(pool, job.id, 'sent');
      if (wamid) {
        await recordOutbound(pool, {
          conversationId: job.conversation_id,
          waMessageId: wamid,
          type: 'template',
          body: `[template] ${job.template_name}`,
        });
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

      let decision;
      try {
        // Reuse whatever packs the conversation already had, plus the
        // campaign's own if any. Auto resume has no new message to run
        // keyword matching against, so this is what the last live turn had.
        const sticky = await getActivePackIds(pool, row.id);
        const packs = ['base'];
        if (row.topic_id) packs.push(Number(row.topic_id));
        for (const id of sticky) if (!packs.includes(id)) packs.push(id);
        decision = await buildReply(pool, ai, settings, row.id, {
          packs,
          faqBudgetTokens: config.faqBudgetTokens,
          allowPackRequests: false,
        });
      } catch {
        // fall back below
      }

      if (decision?.replyLanguage) {
        await setReplyLanguage(pool, row.id, decision.replyLanguage);
      }

      // Mirrors respondToLead in handlers/message.js - the model's decision
      // here carries exactly the same handoff/block/reaction meaning as it
      // does on a live message, so it needs the same handling, not just the
      // plain-text path this used to fall through to unconditionally.
      if (decision?.handoff) {
        const reason = decision.reason || 'The ai judged this needs a person';
        const reasonCategory = categorizeHandoffReason(reason);
        await handToPending(pool, row.id, reason);
        await recordHandoff(pool, { conversationId: row.id, source: 'ai', reason, reasonCategory, topicId: row.topic_id ?? null });
        await cancelDrips(pool, row.id);
        log.info({ conversationId: row.id, reason, reasonCategory }, 'auto resume: ai queued conversation for a human');
        const wamid = await meta.sendText(row.wa_id, decision.reply || settings.handoffMessage);
        if (wamid) await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: decision.reply || settings.handoffMessage });
        await pushHandoff(pool, row.id, reason, log);
        realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
        continue;
      }

      if (decision?.block) {
        const reply = decision.reply || 'This conversation has been closed.';
        const wamid = await meta.sendText(row.wa_id, reply);
        if (wamid) await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: reply });
        await setConversationBlocked(pool, row.id, true);
        await cancelDrips(pool, row.id);
        log.info({ conversationId: row.id, reason: decision.reason }, 'auto resume: ai blocked conversation');
        realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
        continue;
      }

      if (decision?.reactEmoji && row.last_inbound_wamid) {
        await maybeSendReaction(deps, row.id, row.wa_id, row.last_inbound_wamid, decision.reactEmoji);
      }

      // A reaction alone was a complete response - nothing left to send.
      if (!decision?.reply && decision?.reactEmoji) continue;

      const reply = decision?.reply || settings.fallbackMessage;
      const wamid = await meta.sendText(row.wa_id, reply);
      if (wamid) {
        await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: reply });
        if (decision?.sendMediaId) await maybeSendMedia(deps, row.id, row.wa_id, decision.sendMediaId);
        realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
      }
    } catch (err) {
      log.error({ conversationId: row.id, err }, 'auto resume failed');
    }
  }
  return rows.length;
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

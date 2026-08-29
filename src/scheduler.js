import { claimDueDrips, markDrip, recordOutbound, conversationsToResume } from './db/repo.js';
import { handToBot } from './handoff.js';
import { buildReply } from './ai/reply.js';
import { getSettings } from './settings.js';
import { getLearningCursor, runWeeklyLearning } from './knowledge/learning.js';

// Runs the recurring background work: drip follow ups, the auto resume that
// hands stalled chats back to the bot, and the weekly learning pass. In
// process on an interval, single instance is fine for now.
export function startScheduler(deps, intervalMs = 60000) {
  const tick = async () => {
    try {
      await runDueDrips(deps);
      await runAutoResume(deps);
      await runWeeklyLearningIfDue(deps);
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
  const jobs = await claimDueDrips(pool, 20);

  for (const job of jobs) {
    try {
      const wamid = await meta.sendTemplate(job.wa_id, job.template_name, settings.dripLanguage);
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
      await markDrip(pool, job.id, 'failed');
      log.error({ jobId: job.id, err }, 'drip send failed');
    }
  }

  return jobs.length;
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
        decision = await buildReply(pool, ai, settings, row.id, {
          topicId: row.topic_id ?? null,
          faqBudgetTokens: config.faqBudgetTokens,
        });
      } catch {
        // fall back below
      }
      const reply = decision?.reply || settings.fallbackMessage;
      const wamid = await meta.sendText(row.wa_id, reply);
      if (wamid) {
        await recordOutbound(pool, { conversationId: row.id, waMessageId: wamid, body: reply });
        realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
      }
    } catch (err) {
      log.error({ conversationId: row.id, err }, 'auto resume failed');
    }
  }
  return rows.length;
}

// Runs the weekly learning pass once the configured interval has elapsed
// since the last run, otherwise does nothing. Checked every tick rather than
// on its own timer so there is no second interval to manage.
export async function runWeeklyLearningIfDue(deps) {
  const { pool, ai, config, log } = deps;
  const cursor = await getLearningCursor(pool);
  const intervalMs = (config.learningIntervalDays ?? 7) * 24 * 60 * 60 * 1000;
  if (cursor.lastRunAt && Date.now() - new Date(cursor.lastRunAt).getTime() < intervalMs) return null;

  try {
    const result = await runWeeklyLearning(pool, ai);
    log.info(result, 'weekly learning pass completed');
    return result;
  } catch (err) {
    log.error({ err }, 'weekly learning pass failed');
    return null;
  }
}

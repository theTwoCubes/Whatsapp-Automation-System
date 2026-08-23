import { dueDrips, markDrip, recordOutbound, conversationsToResume } from './db/repo.js';
import { handToBot } from './handoff.js';
import { buildReply } from './ai/reply.js';

// Runs the recurring background work: drip follow ups and the auto resume that
// hands stalled chats back to the bot. In process on an interval, single
// instance is fine for now.
export function startScheduler(deps, intervalMs = 60000) {
  const tick = async () => {
    try {
      await runDueDrips(deps);
      await runAutoResume(deps);
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
  const jobs = await dueDrips(pool, 20);

  for (const job of jobs) {
    try {
      const wamid = await meta.sendTemplate(job.wa_id, job.template_name, config.dripLanguage);
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
  if (!config.resumeMinutes || config.resumeMinutes <= 0) return 0;

  const rows = await conversationsToResume(pool, config.resumeMinutes);
  for (const row of rows) {
    try {
      await handToBot(pool, row.id);
      realtime?.emit({ type: 'refresh', conversationId: String(row.id) });
      log.info({ conversationId: row.id }, 'auto resumed conversation to the bot');

      let decision;
      try {
        decision = await buildReply(pool, ai, config, row.id);
      } catch {
        // fall back below
      }
      const reply = decision?.reply || config.fallbackMessage;
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

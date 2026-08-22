import { dueDrips, markDrip, recordOutbound } from './db/repo.js';

// Polls for due drip follow ups and sends the templates. Runs in process on an
// interval. Single instance is fine for now.
export function startScheduler(deps, intervalMs = 60000) {
  const tick = () => runDueDrips(deps).catch((err) => deps.log.error({ err }, 'drip tick failed'));
  const timer = setInterval(tick, intervalMs);
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

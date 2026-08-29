import { listFaqs, listPacks } from './faqs.js';

// Weekly refinement. Two passes, both proposal-only: nothing here goes live
// on its own. The client sees what was found and either approves an entry,
// edits and approves it, or dismisses it.
//
// Gaps: walk every ai-decided handoff since the last run, group the lead's
// question and the reason the bot gave, and ask the model to write a Q&A
// that would have covered each cluster.
//
// Contradictions: for each pack, ask the model to point out pairs of live
// answers that disagree with each other, so a pricing update that missed a
// sibling entry does not silently ship two different prices.

const MAX_GAP_SAMPLES = 120;
const MAX_CONVOS_PER_CLUSTER = 8;

export async function getRefinementCursor(pool) {
  const res = await pool.query('select last_handoff_id, last_run_at from learning_state where id = 1');
  const row = res.rows[0] ?? { last_handoff_id: 0, last_run_at: null };
  return { lastHandoffId: Number(row.last_handoff_id), lastRunAt: row.last_run_at };
}

async function setRefinementCursor(pool, lastHandoffId) {
  await pool.query(
    'update learning_state set last_handoff_id = $1, last_run_at = now() where id = 1',
    [lastHandoffId],
  );
}

// One pass covering both gaps and contradictions. Returns a summary the
// caller can log or return to the console.
export async function runWeeklyRefinement(pool, ai) {
  if (!ai?.enabled) {
    return { gaps: { scanned: 0, proposed: 0 }, contradictions: { scanned: 0, proposed: 0 } };
  }
  const gaps = await runGapPass(pool, ai);
  const contradictions = await runContradictionPass(pool, ai);
  return { gaps, contradictions };
}

async function runGapPass(pool, ai) {
  const cursor = await getRefinementCursor(pool);
  const events = (
    await pool.query(
      `select h.id, h.conversation_id, h.reason, h.topic_id, m.body as lead_message
       from handoff_events h
       left join messages m on m.id = h.message_id
       where h.id > $1 and h.source = 'ai' and m.body is not null
       order by h.id
       limit $2`,
      [cursor.lastHandoffId, MAX_GAP_SAMPLES],
    )
  ).rows;

  if (events.length === 0) {
    await setRefinementCursor(pool, cursor.lastHandoffId);
    return { scanned: 0, proposed: 0 };
  }

  // Group by (topic, whatever the model calls the same underlying gap). We
  // let the model do the grouping since it can see through wording differences
  // that a naive similarity check would miss. Feed one bucket per topic so a
  // proposed answer belongs somewhere obvious.
  let proposed = 0;
  let maxSeenId = cursor.lastHandoffId;

  const byTopic = new Map();
  for (const e of events) {
    maxSeenId = Math.max(maxSeenId, Number(e.id));
    const key = String(e.topic_id ?? 'base');
    if (!byTopic.has(key)) byTopic.set(key, { topicId: e.topic_id, samples: [] });
    byTopic.get(key).samples.push(e);
  }

  for (const { topicId, samples } of byTopic.values()) {
    const clusters = await extractGapClusters(ai, samples);
    for (const c of clusters) {
      const question = String(c.question || '').trim().slice(0, 300);
      const answer = String(c.suggested_answer || '').trim();
      const clusterReason = String(c.reason || '').trim().slice(0, 300);
      const conversationIds = (Array.isArray(c.sample_conversation_ids) ? c.sample_conversation_ids : [])
        .map(Number)
        .filter(Number.isInteger)
        .slice(0, MAX_CONVOS_PER_CLUSTER);
      if (!question) continue;

      await pool.query(
        `insert into faq_proposals (kind, topic_id, question, answer, reason, sample_conversation_ids)
         values ('gap', $1, $2, $3, $4, $5)`,
        [topicId ?? null, question, answer || null, clusterReason || null, conversationIds],
      );
      proposed += 1;
    }
  }

  await setRefinementCursor(pool, maxSeenId);
  return { scanned: events.length, proposed };
}

async function extractGapClusters(ai, samples) {
  const lines = samples
    .map((s) => `- Conversation ${s.conversation_id}: "${s.lead_message}" (bot said: ${s.reason || 'no reason given'})`)
    .join('\n');
  try {
    const raw = await ai.complete(
      [
        {
          role: 'system',
          content:
            'These are questions from real customers that our WhatsApp bot could not answer, one line per handoff, with the reason the bot gave. Group them into a small number of underlying gaps in our answers. For each gap, write one short customer style question that captures it and a plausible short answer that we could then edit and approve. If different customers asked the same thing worded differently, that is one gap, not several. Only propose an answer when at least two customers hit the same gap, or one customer asked something so clearly common it should have been covered. Do not invent facts, keep the suggested_answer short and generic enough that the client will need to fill in the specifics. Return JSON of the shape {"gaps":[{"question":"a short customer style question","suggested_answer":"a short draft the client can then edit","reason":"why this is a gap in a phrase","sample_conversation_ids":[1,2]}]}. If the input does not indicate any real gap, return an empty list.',
        },
        { role: 'user', content: lines },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.gaps)) return parsed.gaps;
  } catch {
    // best effort, an unparseable batch just produces no proposals
  }
  return [];
}

async function runContradictionPass(pool, ai) {
  const packs = await listPacks(pool);
  let scanned = 0;
  let proposed = 0;

  for (const p of packs) {
    const rows = (await listFaqs(pool, { pack: p.topic_id ?? 'base' })).filter((f) => f.active);
    if (rows.length < 2) continue;
    scanned += 1;
    const pairs = await extractContradictions(ai, rows);
    for (const pair of pairs) {
      const a = Number(pair.faq_id_a);
      const b = Number(pair.faq_id_b);
      const ids = new Set(rows.map((r) => Number(r.id)));
      // Reject anything the model made up, or a pair that names the same row.
      if (!ids.has(a) || !ids.has(b) || a === b) continue;
      const reason = String(pair.reason || '').trim().slice(0, 500);
      if (!reason) continue;

      // Order deterministically so re-running does not stack duplicates.
      const [low, high] = a < b ? [a, b] : [b, a];
      const existing = await pool.query(
        `select id from faq_proposals
         where kind = 'contradiction' and status = 'open'
           and faq_id_a = $1 and faq_id_b = $2`,
        [low, high],
      );
      if (existing.rows.length > 0) continue;

      await pool.query(
        `insert into faq_proposals (kind, topic_id, faq_id_a, faq_id_b, reason)
         values ('contradiction', $1, $2, $3, $4)`,
        [p.topic_id ?? null, low, high, reason],
      );
      proposed += 1;
    }
  }

  return { scanned, proposed };
}

async function extractContradictions(ai, rows) {
  const packText = rows.map((r) => `[id ${r.id}] Q: ${r.question}\nA: ${r.answer}`).join('\n\n');
  try {
    const raw = await ai.complete(
      [
        {
          role: 'system',
          content:
            'These are the answers our WhatsApp bot uses for one service pack. Point out pairs of answers that clearly contradict each other on a fact a customer would notice, such as different prices for the same thing, different timelines, or opposite policies. Ignore pairs that just cover different aspects of the same topic, and ignore differences that are only wording. Return JSON of the shape {"contradictions":[{"faq_id_a":1,"faq_id_b":2,"reason":"one short phrase saying what disagrees"}]}. Use only the ids shown in brackets. If nothing genuinely disagrees, return an empty list.',
        },
        { role: 'user', content: packText },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.contradictions)) return parsed.contradictions;
  } catch {
    // best effort
  }
  return [];
}

// Console side: list, approve (creates a real FAQ), dismiss.
export async function listProposals(pool, { status = 'open' } = {}) {
  return (
    await pool.query(
      `select p.id, p.kind, p.topic_id, p.question, p.answer, p.reason,
              p.faq_id_a, p.faq_id_b, p.sample_conversation_ids, p.status,
              p.created_at, p.resolved_at, p.resolved_by, t.name as topic_name,
              fa.question as faq_a_question, fa.answer as faq_a_answer,
              fb.question as faq_b_question, fb.answer as faq_b_answer
       from faq_proposals p
       left join topics t on t.id = p.topic_id
       left join faqs fa on fa.id = p.faq_id_a
       left join faqs fb on fb.id = p.faq_id_b
       where p.status = $1
       order by p.created_at desc, p.id desc
       limit 200`,
      [status],
    )
  ).rows;
}

export async function dismissProposal(pool, id, actor = null) {
  await pool.query(
    `update faq_proposals set status = 'dismissed', resolved_at = now(), resolved_by = $2 where id = $1`,
    [id, actor],
  );
}

export async function markProposalApproved(pool, id, actor = null) {
  await pool.query(
    `update faq_proposals set status = 'approved', resolved_at = now(), resolved_by = $2 where id = $1`,
    [id, actor],
  );
}

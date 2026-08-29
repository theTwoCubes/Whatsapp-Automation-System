import { listFaqs, createFaq } from './faqs.js';

// Weekly learning: scans conversation transcripts for general business facts
// a team member stated that are not already in the knowledge base, and
// queues them for review instead of activating them straight away, since a
// transcript can contain lead specific detail that should never be repeated
// back to someone else. Cursor based so each run only looks at messages
// added since the last one, not the whole history every time.

const MAX_FACTS_PER_CONVERSATION = 8;
const TRANSCRIPT_CHAR_LIMIT = 12000;

export async function getLearningCursor(pool) {
  const res = await pool.query('select last_message_id, last_run_at from learning_state where id = 1');
  const row = res.rows[0] ?? { last_message_id: 0, last_run_at: null };
  return { lastMessageId: Number(row.last_message_id), lastRunAt: row.last_run_at };
}

async function setLearningCursor(pool, lastMessageId) {
  await pool.query(
    'update learning_state set last_message_id = $1, last_run_at = now() where id = 1',
    [lastMessageId],
  );
}

// Runs one learning pass. Best effort throughout: a failure on one
// conversation's transcript does not stop the rest, and the cursor only
// advances past messages that were actually looked at.
export async function runWeeklyLearning(pool, ai) {
  if (!ai?.enabled) return { conversationsScanned: 0, added: 0, skipped: 0 };

  const cursor = await getLearningCursor(pool);
  const rows = (
    await pool.query(
      `select m.id, m.conversation_id, m.direction, m.body, ca.topic_id
       from messages m
       join conversations c on c.id = m.conversation_id
       left join campaigns ca on ca.id = c.campaign_id
       where m.id > $1 and m.type = 'text' and m.body is not null and m.direction is not null
       order by m.conversation_id, m.id`,
      [cursor.lastMessageId],
    )
  ).rows;

  if (rows.length === 0) {
    await setLearningCursor(pool, cursor.lastMessageId);
    return { conversationsScanned: 0, added: 0, skipped: 0 };
  }

  const byConversation = new Map();
  let maxId = cursor.lastMessageId;
  for (const row of rows) {
    maxId = Math.max(maxId, row.id);
    if (!byConversation.has(row.conversation_id)) byConversation.set(row.conversation_id, { topicId: row.topic_id, messages: [] });
    byConversation.get(row.conversation_id).messages.push(row);
  }

  let added = 0;
  let skipped = 0;

  for (const { topicId, messages } of byConversation.values()) {
    const transcript = messages
      .map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Team'}: ${m.body}`)
      .join('\n')
      .slice(0, TRANSCRIPT_CHAR_LIMIT);

    const existing = new Set(
      (await listFaqs(pool, { pack: topicId ?? 'base' })).map((f) => normalise(f.question)),
    );

    const facts = await extractBusinessFacts(ai, transcript);
    for (const f of facts.slice(0, MAX_FACTS_PER_CONVERSATION)) {
      const question = (f.question || '').trim();
      const answer = (f.answer || '').trim();
      if (!question || !answer || existing.has(normalise(question))) {
        skipped += 1;
        continue;
      }
      try {
        await createFaq(
          pool,
          {
            topicId: topicId ?? null,
            question: question.slice(0, 300),
            answer,
            source: 'learned',
            active: false,
          },
          'weekly learning',
        );
        existing.add(normalise(question));
        added += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  await setLearningCursor(pool, maxId);
  return { conversationsScanned: byConversation.size, added, skipped };
}

// Asks the model for only general, reusable facts a team member stated,
// explicitly excluding anything specific to the one lead in that transcript.
async function extractBusinessFacts(ai, transcript) {
  try {
    const raw = await ai.complete(
      [
        {
          role: 'system',
          content:
            'This is a WhatsApp conversation between a lead and our team. Extract only general, reusable questions and answers about the business, its services, pricing, or policies that the team stated, which are not already common sense. Ignore anything specific to this one lead: their name, personal situation, dates, or quantities specific to their order. If nothing general and reusable was said, return an empty list. Return JSON of the shape {"faqs":[{"question":"the question a customer would ask","answer":"the answer the team gave"}]}. Copy figures such as prices and timelines exactly as stated. Do not invent anything not actually said in the conversation.',
        },
        { role: 'user', content: transcript },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.faqs)) {
      return parsed.faqs.map((f) => ({
        question: String(f.question || '').trim(),
        answer: String(f.answer || '').trim(),
      }));
    }
  } catch {
    // learning is best effort, skip this conversation's transcript on failure
  }
  return [];
}

function normalise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

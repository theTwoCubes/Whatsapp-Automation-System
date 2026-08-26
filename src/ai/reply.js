import { getConversationHistory } from '../db/repo.js';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { humanize } from './sanitize.js';

// A cheap keyword backstop. The AI decides handoff on its own too, this just
// catches the obvious asks instantly without spending a call.
const handoffPatterns = [
  /talk to (a )?(human|person|agent|someone|representative)/i,
  /speak (to|with) (a )?(human|person|agent|someone|representative)/i,
  /real (human|person)/i,
  /customer (care|support|service)/i,
  /human agent/i,
];

export function wantsHuman(text) {
  if (!text) return false;
  return handoffPatterns.some((re) => re.test(text));
}

// Builds a reply for a conversation. Returns { reply, handoff, reason, facts }.
// The AI is asked to answer in the studio's voice and to flag when a human
// should take over, so handoff is judgement based rather than keyword only. The
// query text is passed explicitly so retrieval can score against exactly what
// the lead is asking, not the whole thread.
export async function buildReply(pool, ai, embeddings, config, conversationId, opts = {}) {
  const { query = '', topicId = null } = opts;

  const [facts, history] = await Promise.all([
    retrieveKnowledge(pool, embeddings, query, { topicId }),
    getConversationHistory(pool, conversationId, 14),
  ]);

  const messages = [{ role: 'system', content: systemPrompt(config, facts) }];
  for (const m of history) {
    messages.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body ?? '' });
  }

  const raw = await ai.complete(messages, { json: true });
  const parsed = parseDecision(raw);

  return {
    reply: parsed.reply ? humanize(parsed.reply) : '',
    handoff: Boolean(parsed.handoff),
    reason: parsed.reason ?? '',
    facts: facts.map((f) => ({ id: f.id, title: f.title })),
  };
}

// The model is asked for JSON, but stay tolerant: if it ever returns plain text,
// treat the whole thing as the reply.
function parseDecision(raw) {
  if (!raw) return { reply: '', handoff: false };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && ('reply' in obj || 'handoff' in obj)) {
      return obj;
    }
  } catch {
    // not json, fall through
  }
  return { reply: raw, handoff: false };
}

function systemPrompt(config, facts) {
  const kbText = facts.length
    ? facts.map((k) => `- ${k.title}: ${k.content}`).join('\n')
    : 'No matching knowledge for this question.';

  return [
    `You are the WhatsApp assistant for ${config.businessName}.`,
    config.businessAbout,
    '',
    'How to write:',
    `- Sound like a real person on the team, warm and ${config.businessTone}.`,
    '- Keep it short, one or two sentences, the way people actually text.',
    '- Never use markdown, asterisks, bold, bullet points or dashes for style. Plain sentences only.',
    '',
    'Your job is to nurture the lead:',
    '- Be genuinely helpful first, answer their question from the knowledge below.',
    '- Gently move things forward by asking one useful question at a time (what they need, timeline, budget), never pushy, never salesy.',
    '- If the knowledge below does not cover the question, say a colleague will help rather than making things up.',
    '',
    'Hand the chat to a human when it is the right call, for example: the person is upset or unhappy, they want to negotiate price or a custom quote, they ask for a human, it is a complaint, or you are unsure and guessing would risk a bad impression. It is better to hand off than to answer badly.',
    '',
    'Reply only as JSON with this shape: {"reply": "the message to send", "handoff": true or false, "reason": "short reason if handoff"}.',
    'If handoff is true, put a brief friendly holding message in reply, like letting them know someone from the team will jump in.',
    '',
    'Relevant knowledge:',
    kbText,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

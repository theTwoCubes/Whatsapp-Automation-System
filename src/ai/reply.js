import { getConversationHistory, getActiveKnowledge } from '../db/repo.js';

const handoffPatterns = [
  /talk to (a )?(human|person|agent|someone|representative)/i,
  /speak (to|with) (a )?(human|person|agent|someone|representative)/i,
  /real (human|person)/i,
  /customer (care|support|service)/i,
  /human agent/i,
];

// True when the lead is asking to reach a person rather than the bot.
export function wantsHuman(text) {
  if (!text) return false;
  return handoffPatterns.some((re) => re.test(text));
}

// Builds the reply for a conversation from the business identity, the knowledge
// base and the recent history, then asks the AI client for an answer. The most
// recent inbound message is already part of the history.
export async function buildReply(pool, ai, config, conversationId) {
  const [kb, history] = await Promise.all([
    getActiveKnowledge(pool),
    getConversationHistory(pool, conversationId, 12),
  ]);

  const messages = [{ role: 'system', content: buildSystemPrompt(config, kb) }];
  for (const m of history) {
    messages.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body ?? '' });
  }

  return ai.complete(messages);
}

function buildSystemPrompt(config, kb) {
  const kbText = kb.length
    ? kb.map((k) => `- ${k.title}: ${k.content}`).join('\n')
    : 'No knowledge base entries yet.';

  return [
    `You are the WhatsApp assistant for ${config.businessName}.`,
    config.businessAbout,
    `Keep the tone ${config.businessTone}.`,
    'Answer using the knowledge base below. If the answer is not there, say you will pass it to the team rather than guessing.',
    'Keep replies short and easy to read on WhatsApp.',
    'Knowledge base:',
    kbText,
  ]
    .filter(Boolean)
    .join('\n');
}

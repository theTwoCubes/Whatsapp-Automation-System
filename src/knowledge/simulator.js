import { buildFaqContext } from './context.js';
import { keywordPacks, packCatalog } from './packs.js';
import { buildReply } from '../ai/reply.js';

// Dry runs the reply pipeline against a hypothetical message without touching
// the conversation or sending anything. Returns exactly what the model would
// be shown and, if we can afford the call, exactly what it would answer.
// This is the client's confidence check before a change goes live.
//
// The pack assembly, prompt, and contract handling all match what the real
// pipeline uses. If anything drifts between here and the live path a client
// change verified in the simulator could still misbehave in a real chat, so
// the two must call into the same helpers rather than reimplement them.
export async function simulateReply(pool, ai, config, settings, { text, topicId = null, callAi = true } = {}) {
  const query = String(text || '').trim();
  if (!query) throw new Error('a customer message is required');

  const packs = ['base'];
  if (topicId) packs.push(Number(topicId));
  const seen = new Set(packs.map(String));
  const keywordHits = await keywordPacks(pool, query, [...seen].filter((k) => k !== 'base').map(Number));
  for (const id of keywordHits) {
    if (!seen.has(String(id))) {
      seen.add(String(id));
      packs.push(id);
    }
  }

  const topicIds = packs.filter((p) => p !== 'base');
  const [faqs, catalog] = await Promise.all([
    buildFaqContext(pool, { packs, budgetTokens: config.faqBudgetTokens }),
    packCatalog(pool, topicIds),
  ]);

  const trace = {
    packsIncluded: faqs.packs,
    keywordMatches: keywordHits,
    catalog: catalog.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    faqCount: faqs.faqCount,
    contextTokens: faqs.tokens,
    droppedForBudget: faqs.dropped,
    context: faqs.text,
  };

  if (!callAi || !ai?.enabled) {
    return { ...trace, decision: null, reason: !ai?.enabled ? 'AI provider not configured' : 'skipped by request' };
  }

  // The reply pipeline pulls history and lead context by conversation id. We
  // pass an id that will not resolve to anything, so both come back empty, and
  // feed the customer's message in as an extra synthetic turn. That way the
  // simulator reflects a fresh lead's first message, which is the case a
  // client most needs to reason about when they change wording.
  const decision = await buildReply(pool, ai, settings, -1, {
    packs,
    faqBudgetTokens: settings.faqBudgetTokens,
    extraTurns: [{ direction: 'inbound', body: query }],
  });
  return { ...trace, decision };
}

import { buildFaqContext } from './context.js';
import { keywordPacks, packCatalog } from './packs.js';
import { buildReply } from '../ai/reply.js';
import { getMediaCatalog, getPaymentLinkCatalog, getHostedLinkCatalog } from '../db/repo.js';

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
  const [faqs, catalog, media, paymentLinks, hostedLinks] = await Promise.all([
    buildFaqContext(pool, { packs, budgetTokens: config.faqBudgetTokens }),
    packCatalog(pool, topicIds),
    getMediaCatalog(pool, topicIds),
    getPaymentLinkCatalog(pool, topicIds),
    getHostedLinkCatalog(pool, topicIds),
  ]);

  // Exposing the media / payment / hosted-link catalogs on the trace is what
  // lets a client debug "why didn't the AI send that video I uploaded?" -
  // without this they can only see the FAQ context and would have to guess
  // whether the file was scoped to the wrong pack or missing altogether.
  const trace = {
    packsIncluded: faqs.packs,
    keywordMatches: keywordHits,
    catalog: catalog.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    media: media.map((m) => ({ id: m.id, filename: m.filename, description: m.description, topic_id: m.topic_id })),
    paymentLinks: paymentLinks.map((p) => ({ id: p.id, label: p.label, amount_inr: p.amount_inr, description: p.description, topic_id: p.topic_id })),
    hostedLinks: hostedLinks.map((h) => ({ id: h.id, label: h.label, description: h.description, topic_id: h.topic_id })),
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
    // faqBudgetTokens lives on the env config, not the DB settings object -
    // passing settings.faqBudgetTokens fed an undefined budget into
    // buildFaqContext, so the simulator's context was uncapped.
    faqBudgetTokens: config.faqBudgetTokens,
    extraTurns: [{ direction: 'inbound', body: query }],
  });
  return { ...trace, decision };
}

import { listPacks } from './faqs.js';

// Decides which packs go into a reply. Base is always in. The lead's own
// service pack, from their campaign, is always in. On top of that, packs are
// pulled in two ways: cheaply by matching the customer's words against a
// pack's name and keywords with no extra AI call, and, only when that is not
// enough, by the model asking for one by name. Whatever gets pulled in sticks
// for the rest of the conversation so it is never renegotiated turn by turn.

// The catalog the model is shown so it knows what it can ask for. Only packs
// that are not already in the context are listed, so it never asks for one it
// already has.
export async function packCatalog(pool, includedTopicIds) {
  const included = new Set(includedTopicIds.map(String));
  const packs = await listPacks(pool);
  return packs
    .filter((p) => p.topic_id != null && p.faq_count > 0 && !included.has(String(p.topic_id)))
    .map((p) => ({ id: Number(p.topic_id), name: p.name, description: p.description }));
}

// Matches the customer's message against each pack's name, slug and keywords.
// Whole word matches only, with a common plural allowance so "posters" hits a
// "poster" keyword, and case insensitive since the message is normalised. So
// "logo" pulls the logo pack, "blog" does not. Returns topic ids, most words
// matched first.
export async function keywordPacks(pool, text, excludeTopicIds = []) {
  const exclude = new Set(excludeTopicIds.map(String));
  const words = new Set(normalise(text).split(' ').filter(Boolean).map(stem));
  if (words.size === 0) return [];

  const topics = (
    await pool.query(
      `select t.id, t.name, t.slug, t.keywords
       from topics t
       where t.active = true
         and exists (select 1 from faqs f where f.topic_id = t.id and f.active)`,
    )
  ).rows;

  const scored = [];
  for (const t of topics) {
    if (exclude.has(String(t.id))) continue;
    const terms = packTerms(t);
    let hits = 0;
    for (const term of terms) {
      // Multi word terms match as a phrase, single word terms are matched
      // against the stemmed word set so plurals count as the same word.
      if (term.includes(' ')) {
        if (` ${normalise(text)} `.includes(` ${term} `)) hits += 1;
      } else if (words.has(stem(term))) {
        hits += 1;
      }
    }
    if (hits > 0) scored.push({ id: Number(t.id), hits });
  }
  return scored.sort((a, b) => b.hits - a.hits).map((s) => s.id);
}

// Strips a common plural ending, so "posters" and "poster" collapse together.
// Deliberately naive: this is a match heuristic, not real morphology.
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// The words that pull a pack in: its name, its slug, and whatever the client
// added, each normalised the same way the message is.
function packTerms(topic) {
  const raw = [topic.name, topic.slug.replace(/_/g, ' '), ...(topic.keywords ? topic.keywords.split(',') : [])];
  const terms = new Set();
  for (const r of raw) {
    const n = normalise(r);
    if (n.length >= 3) terms.add(n);
  }
  return terms;
}

function normalise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

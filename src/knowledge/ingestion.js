import { addKnowledgeUnit } from './writer.js';

// Turns raw text (an FAQ dump, a doc, a note) into atomic, deduped knowledge
// units. If the AI client is available we use it to split the text into
// individual facts. If it is not, we fall back to a heuristic that recognises
// FAQ style Q: A: pairs and paragraph splits. Every unit goes through the
// dedup gated writer, so nothing already stored gets duplicated.
//
// Returns { added, skipped, units } so the caller can report exactly what
// happened. Never throws for individual unit failures, they are logged as skips.

const MAX_UNITS_PER_INGEST = 200;

export async function ingestText(pool, ai, embeddings, raw, { scope, topicId = null, source = 'ingested', threshold } = {}) {
  const text = String(raw || '').trim();
  if (!text) return { added: 0, skipped: 0, units: [] };

  const candidates = await extractCandidates(ai, text);
  const capped = candidates.slice(0, MAX_UNITS_PER_INGEST);

  let added = 0;
  let skipped = 0;
  const units = [];
  for (const c of capped) {
    if (!c.title || !c.content) {
      skipped += 1;
      continue;
    }
    try {
      const res = await addKnowledgeUnit(
        pool,
        embeddings,
        {
          title: c.title.slice(0, 200),
          content: c.content,
          scope,
          topicId,
          source,
        },
        { threshold },
      );
      if (res.added) {
        added += 1;
        units.push({ id: res.id, title: c.title });
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { added, skipped, units };
}

// Ask the model to split the text into JSON facts. If the AI is not configured
// or fails, use the heuristic splitter.
async function extractCandidates(ai, text) {
  if (ai?.enabled) {
    try {
      const raw = await ai.complete(
        [
          {
            role: 'system',
            content:
              'You extract atomic knowledge facts from raw text. Return JSON of the shape {"facts":[{"title":"short label","content":"one self contained fact"}]}. Every distinct point in the input must appear as its own fact, no summarising, no losing detail. Merge only true near duplicates. Keep the wording clean and neutral. Do not invent anything not in the input.',
          },
          { role: 'user', content: text.slice(0, 12000) },
        ],
        { json: true },
      );
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.facts) && parsed.facts.length > 0) {
        return parsed.facts.map((f) => ({ title: String(f.title || '').trim(), content: String(f.content || '').trim() }));
      }
    } catch {
      // fall through
    }
  }
  return heuristicSplit(text);
}

// FAQ style Q:/A: pairs, then blank line separated paragraphs as a last resort.
function heuristicSplit(text) {
  const out = [];
  const lines = text.split('\n');
  let question = null;
  let answer = [];
  const flush = () => {
    if (question && answer.length) {
      const title = question.replace(/^Q[:.]\s*/i, '').trim().slice(0, 120);
      const content = answer.join(' ').replace(/^A[:.]\s*/i, '').trim();
      if (title && content) out.push({ title, content });
    }
    question = null;
    answer = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (/^Q[:.]/i.test(t)) {
      flush();
      question = t;
    } else if (/^A[:.]/i.test(t)) {
      answer = [t];
    } else if (t) {
      if (answer.length) answer.push(t);
    } else {
      flush();
    }
  }
  flush();

  if (out.length > 0) return out;

  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ title: p.split(/[.!?]/)[0].slice(0, 120), content: p }));
}

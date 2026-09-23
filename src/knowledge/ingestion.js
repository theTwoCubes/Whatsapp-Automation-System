import { listFaqs, createFaq, updateFaq } from './faqs.js';

// Turns raw text (an FAQ dump, a doc, a note) into individual question and
// answer pairs in a pack. If the AI client is available we use it to split the
// text, otherwise a heuristic handles FAQ style Q: A: pairs and paragraphs.
//
// Matches are caught by comparing normalised question text against what is
// already in the pack. That is deliberately literal rather than similarity
// based: the client can see exactly why something matched, and two genuinely
// different questions never collapse into one. A matched question whose
// answer has changed is updated in place rather than skipped - this is what
// lets a client download a pack, tweak a couple of lines, and paste the whole
// thing back without deleting first or ending up with duplicates.
//
// Returns { added, updated, skipped, faqs } so the caller can report what
// happened. Never throws for individual failures, they are counted as skips.

const MAX_UNITS_PER_INGEST = 200;

export async function ingestText(pool, ai, raw, { topicId = null, source = 'ingested', actor = null } = {}) {
  const text = String(raw || '').trim();
  if (!text) return { added: 0, updated: 0, skipped: 0, faqs: [] };

  const candidates = (await extractCandidates(ai, text)).slice(0, MAX_UNITS_PER_INGEST);

  const existing = new Map(
    (await listFaqs(pool, { pack: topicId ?? 'base' })).map((f) => [normalise(f.question), f]),
  );

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const faqs = [];
  for (const c of candidates) {
    const question = (c.question || '').trim();
    const answer = (c.answer || '').trim();
    const key = normalise(question);
    if (!question || !answer) {
      skipped += 1;
      continue;
    }
    const match = existing.get(key);
    try {
      if (match) {
        if (match.answer.trim() === answer) {
          skipped += 1;
          continue;
        }
        const faq = await updateFaq(pool, match.id, { answer }, actor);
        existing.set(key, faq);
        updated += 1;
        faqs.push({ id: faq.id, question: faq.question });
      } else {
        const faq = await createFaq(
          pool,
          { topicId, question: question.slice(0, 300), answer, source },
          actor,
        );
        existing.set(key, faq);
        added += 1;
        faqs.push({ id: faq.id, question: faq.question });
      }
    } catch {
      skipped += 1;
    }
  }
  return { added, updated, skipped, faqs };
}

function normalise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ask the model to split the text into question and answer pairs. If the AI is
// not configured or fails, use the heuristic splitter.
async function extractCandidates(ai, text) {
  if (ai?.enabled) {
    try {
      const { text: raw } = await ai.complete(
        [
          {
            role: 'system',
            content:
              'You turn raw business text into a list of customer questions and the answers to them. Return JSON of the shape {"faqs":[{"question":"the question a customer would ask","answer":"the answer, in the words of the business"}]}. Every distinct point in the input must appear as its own entry, no summarising, no losing detail, and copy figures such as prices and timelines exactly as written. Merge only true near duplicates. Do not invent anything not in the input.',
          },
          { role: 'user', content: text.slice(0, 12000) },
        ],
        { json: true },
      );
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.faqs) && parsed.faqs.length > 0) {
        return parsed.faqs.map((f) => ({
          question: String(f.question || '').trim(),
          answer: String(f.answer || '').trim(),
        }));
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
      const q = question.replace(/^Q[:.]\s*/i, '').trim().slice(0, 300);
      const a = answer.join(' ').replace(/^A[:.]\s*/i, '').trim();
      if (q && a) out.push({ question: q, answer: a });
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
    .map((p) => ({ question: p.split(/[.!?]/)[0].slice(0, 300), answer: p }));
}

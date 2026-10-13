import { listFaqs } from './faqs.js';
import { cacheKey, getCached, setCached } from './faqCache.js';

// Assembles the answers the bot is allowed to use, as text, with no ranking or
// similarity search anywhere in the path. Which packs go in is decided by the
// caller and the whole pack goes in, so the same lead asking the same thing
// always gets the same context.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

// packs is an ordered list of 'base' or topic ids, most important first. If
// everything does not fit, entries are dropped from the least important pack
// first and from the end of that pack, since the client controls the order and
// puts what matters at the top. Pinned entries are never dropped.
export async function buildFaqContext(pool, { packs = ['base'], budgetTokens = 12000 } = {}) {
  // De-dupe while preserving order, then load every pack's rows in parallel
  // instead of awaiting them one after another.
  const seen = new Set();
  const ordered = [];
  for (const pack of packs) {
    const key = String(pack);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(pack);
  }

  // Serve from cache when the same pack set was assembled recently. The key
  // folds in the budget so two callers with different budgets never collide.
  const key = `${cacheKey(ordered)}#${budgetTokens}`;
  const cached = getCached(key);
  if (cached) return cached;

  const loaded = await Promise.all(
    ordered.map(async (pack) => {
      const rows = (await listFaqs(pool, { pack, includeInactive: false })).filter((f) => f.active);
      return { pack, rows };
    }),
  );
  const groups = loaded.filter((g) => g.rows.length > 0);

  const kept = trimToBudget(groups, budgetTokens);
  const text = render(kept.groups);

  const result = {
    text,
    packs: kept.groups.map((g) => g.pack),
    faqIds: kept.groups.flatMap((g) => g.rows.map((r) => r.id)),
    faqCount: kept.groups.reduce((n, g) => n + g.rows.length, 0),
    dropped: kept.dropped,
    tokens: estimateTokens(text),
  };
  setCached(key, result);
  return result;
}

// Per-row token cost, so trimming is arithmetic instead of re-rendering the
// entire FAQ text on every dropped row (the old loop was O(n^2)).
function rowTokens(row) {
  const lock = row.verbatim ? ' [quote this answer exactly, word for word]' : '';
  return estimateTokens(`Q [id ${row.id}]: ${row.question}\nA: ${row.answer}${lock}`) + 2;
}

// Drops from the back of the least important pack until it fits. Pinned rows
// are never dropped. Runs in a single pass over the rows: compute the total
// once, then subtract each dropped row's cost.
function trimToBudget(groups, budgetTokens) {
  const working = groups.map((g) => ({ pack: g.pack, rows: [...g.rows] }));
  // Headings and separators add a little overhead per group; approximate it so
  // we do not systematically run over budget.
  const overheadPerGroup = 6;
  let total = working.reduce(
    (sum, g) => sum + overheadPerGroup + g.rows.reduce((s, r) => s + rowTokens(r), 0),
    0,
  );
  let dropped = 0;

  for (let i = working.length - 1; i >= 0 && total > budgetTokens; i -= 1) {
    const rows = working[i].rows;
    for (let j = rows.length - 1; j >= 0 && total > budgetTokens; j -= 1) {
      if (!rows[j].pinned) {
        total -= rowTokens(rows[j]);
        rows.splice(j, 1);
        dropped += 1;
      }
    }
  }

  return { groups: working.filter((g) => g.rows.length > 0), dropped };
}

function render(groups) {
  return groups
    .map((g) => {
      const heading = g.pack === 'base' ? 'General answers' : `Answers for this service`;
      const body = g.rows
        .map((r) => {
          const lock = r.verbatim ? ' [quote this answer exactly, word for word]' : '';
          return `Q [id ${r.id}]: ${r.question}\nA: ${r.answer}${lock}`;
        })
        .join('\n\n');
      return `${heading}\n${body}`;
    })
    .join('\n\n');
}

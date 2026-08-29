import { listFaqs } from './faqs.js';

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
export async function buildFaqContext(pool, { packs = ['base'], budgetTokens = 6000 } = {}) {
  const seen = new Set();
  const groups = [];

  for (const pack of packs) {
    const key = String(pack);
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = (await listFaqs(pool, { pack, includeInactive: false })).filter((f) => f.active);
    if (rows.length > 0) groups.push({ pack, rows });
  }

  const kept = trimToBudget(groups, budgetTokens);
  const text = render(kept.groups);

  return {
    text,
    packs: kept.groups.map((g) => g.pack),
    faqIds: kept.groups.flatMap((g) => g.rows.map((r) => r.id)),
    faqCount: kept.groups.reduce((n, g) => n + g.rows.length, 0),
    dropped: kept.dropped,
    tokens: estimateTokens(text),
  };
}

// Drops from the back of the least important pack until it fits. Pinned rows
// are pulled out of the drop pool entirely rather than being reordered, so an
// entry that survives trimming still sits where the client put it.
function trimToBudget(groups, budgetTokens) {
  const working = groups.map((g) => ({ pack: g.pack, rows: [...g.rows] }));
  let dropped = 0;

  while (estimateTokens(render(working)) > budgetTokens) {
    let removed = false;
    for (let i = working.length - 1; i >= 0 && !removed; i -= 1) {
      const rows = working[i].rows;
      for (let j = rows.length - 1; j >= 0; j -= 1) {
        if (!rows[j].pinned) {
          rows.splice(j, 1);
          dropped += 1;
          removed = true;
          break;
        }
      }
    }
    // Everything left is pinned, so the budget cannot be met without dropping
    // something the client marked as always required. Keep it and go over.
    if (!removed) break;
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
          return `Q: ${r.question}\nA: ${r.answer}${lock}`;
        })
        .join('\n\n');
      return `${heading}\n${body}`;
    })
    .join('\n\n');
}

import { toPgVector } from '../ai/embeddings.js';

// Hybrid knowledge retrieval. pgvector cosine similarity is combined with
// Postgres full text search using reciprocal rank fusion, biased toward the
// lead's topic while keeping base knowledge always eligible. Results are then
// greedily packed into a fixed token budget so the prompt never explodes.

const RRF_K = 60;
const CHARS_PER_TOKEN = 4;
const VECTOR_POOL = 30;
const FTS_POOL = 30;

export async function retrieveKnowledge(pool, embeddingClient, query, opts = {}) {
  const {
    topicId = null,
    topK = 12,
    tokenBudget = 1200,
    similarityFloor = 0.5,
    topicBoost = 0.15,
  } = opts;

  const trimmed = (query || '').trim();
  if (!trimmed) return [];

  // Try to embed. If embeddings are down we fall back to full text only so the
  // system still answers something rather than nothing.
  let embedding = null;
  try {
    embedding = await embeddingClient.embed(trimmed);
  } catch {
    // fall through to fts only
  }

  const [vectorHits, ftsHits] = await Promise.all([
    embedding ? vectorSearch(pool, embedding, similarityFloor) : Promise.resolve([]),
    ftsSearch(pool, trimmed),
  ]);

  const merged = fuseByRank(vectorHits, ftsHits, { topicId, topicBoost });
  return packToBudget(merged, tokenBudget).slice(0, topK);
}

async function vectorSearch(pool, embedding, floor) {
  const vec = toPgVector(embedding);
  const res = await pool.query(
    `select id, title, content, scope, topic_id,
            1 - (embedding <=> $1::vector) as similarity
     from knowledge_base
     where active = true and embedding is not null
       and 1 - (embedding <=> $1::vector) >= $2
     order by embedding <=> $1::vector
     limit $3`,
    [vec, floor, VECTOR_POOL],
  );
  return res.rows;
}

async function ftsSearch(pool, query) {
  const res = await pool.query(
    `select id, title, content, scope, topic_id,
            ts_rank(tsv, websearch_to_tsquery('english', $1)) as rank
     from knowledge_base
     where active = true and tsv @@ websearch_to_tsquery('english', $1)
     order by rank desc
     limit $2`,
    [query, FTS_POOL],
  );
  return res.rows;
}

// Reciprocal rank fusion. A proven, score free way to merge two ranked lists
// so we do not have to normalise their scoring scales against each other.
function fuseByRank(vector, fts, { topicId, topicBoost }) {
  const scores = new Map();

  vector.forEach((row, i) => {
    scores.set(row.id, { row, score: 1 / (RRF_K + i) });
  });
  fts.forEach((row, i) => {
    const s = 1 / (RRF_K + i);
    const existing = scores.get(row.id);
    if (existing) existing.score += s;
    else scores.set(row.id, { row, score: s });
  });

  if (topicId != null) {
    for (const entry of scores.values()) {
      if (String(entry.row.topic_id) === String(topicId)) entry.score += topicBoost;
    }
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.row);
}

function packToBudget(rows, budgetTokens) {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const packed = [];
  let used = 0;
  for (const row of rows) {
    const size = (row.title || '').length + (row.content || '').length + 8;
    if (used + size > budgetChars && packed.length > 0) break;
    packed.push(row);
    used += size;
  }
  return packed;
}

import { toPgVector } from '../ai/embeddings.js';
import { nearestNeighbor } from './dedup.js';

const DEFAULT_DEDUP_THRESHOLD = 0.93;

// Inserts a knowledge unit only if it is materially different from what is
// already stored. Returns { added, id, duplicateOf } so the caller can report
// what happened. If embeddings are unavailable the unit is still stored so the
// fact is not lost, and a later re-embed pass can enrich it.
export async function addKnowledgeUnit(pool, embeddingClient, unit, opts = {}) {
  const { title, content, scope, topicId = null, source = 'manual' } = unit;
  const { threshold = DEFAULT_DEDUP_THRESHOLD } = opts;
  if (!title || !content) throw new Error('title and content are required');

  let embedding = null;
  try {
    embedding = await embeddingClient.embed(`${title}\n${content}`);
  } catch {
    embedding = null;
  }

  if (embedding) {
    const nearest = await nearestNeighbor(pool, embedding, { scope, topicId });
    if (nearest && nearest.similarity >= threshold) {
      return { added: false, id: null, duplicateOf: nearest.id, similarity: nearest.similarity };
    }
  }

  const res = await pool.query(
    `insert into knowledge_base (title, content, scope, topic_id, source, embedding)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [title, content, scope, topicId, source, embedding ? toPgVector(embedding) : null],
  );
  return { added: true, id: res.rows[0].id, duplicateOf: null };
}

import { toPgVector } from '../ai/embeddings.js';

// Finds the closest existing knowledge unit within the same scope and topic,
// so we can skip inserts that would duplicate what is already stored.
export async function nearestNeighbor(pool, embedding, { scope, topicId = null }) {
  const vec = toPgVector(embedding);
  const res = await pool.query(
    `select id, title, content, 1 - (embedding <=> $1::vector) as similarity
     from knowledge_base
     where active = true and embedding is not null
       and scope = $2
       and ((topic_id is null and $3::bigint is null) or topic_id = $3::bigint)
     order by embedding <=> $1::vector
     limit 1`,
    [vec, scope, topicId],
  );
  return res.rows[0] ?? null;
}

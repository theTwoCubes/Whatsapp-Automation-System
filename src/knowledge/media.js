import { toPgVector } from '../ai/embeddings.js';
import { addMediaAsset } from '../db/repo.js';

// Saves a media asset with its description embedded, so it can be found later
// by meaning rather than only by which topic it sits under. Embedding is best
// effort: if it is unavailable the asset still saves, it just will not surface
// through retrieveMedia until re-embedded.
export async function saveMediaAsset(pool, embeddings, asset) {
  const text = (asset.description || asset.caption || '').trim();
  let embedding = null;
  if (text && embeddings?.enabled) {
    try {
      const vector = await embeddings.embed(text);
      embedding = toPgVector(vector);
    } catch {
      embedding = null;
    }
  }
  return addMediaAsset(pool, { ...asset, embedding });
}

// Finds the single best matching media asset for a message, if any. Only
// returns something when the match is genuinely close, a shallow match is
// worse than no attachment at all. A topic match nudges the ranking so a
// lead's own service is favoured without hard filtering out everything else.
export async function retrieveMedia(pool, embeddings, query, opts = {}) {
  const { topicId = null, similarityFloor = 0.72, topicBoost = 0.08 } = opts;
  const text = String(query || '').trim();
  if (!text || !embeddings?.enabled) return null;

  let vector;
  try {
    vector = await embeddings.embed(text);
  } catch {
    return null;
  }
  if (!vector) return null;

  const res = await pool.query(
    `select id, meta_media_id, filename, mime_type, kind, caption, description, topic_id,
            1 - (embedding <=> $1::vector) as similarity
     from media_assets
     where embedding is not null
     order by embedding <=> $1::vector
     limit 5`,
    [toPgVector(vector)],
  );
  if (res.rows.length === 0) return null;

  let best = null;
  for (const row of res.rows) {
    const score = Number(row.similarity) + (topicId && row.topic_id === topicId ? topicBoost : 0);
    if (!best || score > best.score) best = { ...row, score };
  }
  if (Number(best.similarity) < similarityFloor) return null;
  return best;
}

// Data access for topics and topic scoped knowledge lists. Manual small ORM
// style helpers, plain SQL over the shared pg pool.

export async function listTopics(pool) {
  const res = await pool.query(
    `select t.id, t.slug, t.name, t.description, t.active, t.created_at,
            (select count(*) from knowledge_base k where k.topic_id = t.id and k.active) as knowledge_count
     from topics t
     order by t.active desc, t.name`,
  );
  return res.rows;
}

export async function getTopic(pool, id) {
  const res = await pool.query('select id, slug, name, description, active from topics where id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function getTopicBySlug(pool, slug) {
  const res = await pool.query('select id, slug, name, description, active from topics where slug = $1', [slug]);
  return res.rows[0] ?? null;
}

export async function upsertTopic(pool, { slug, name, description }) {
  const res = await pool.query(
    `insert into topics (slug, name, description) values ($1, $2, $3)
     on conflict (slug) do update set
       name = excluded.name,
       description = coalesce(excluded.description, topics.description),
       updated_at = now()
     returning id, slug, name, description, active`,
    [slug, name, description ?? null],
  );
  return res.rows[0];
}

export async function updateTopic(pool, id, fields) {
  await pool.query(
    `update topics set
       name = coalesce($2, name),
       description = coalesce($3, description),
       active = coalesce($4, active),
       updated_at = now()
     where id = $1`,
    [id, fields.name ?? null, fields.description ?? null, fields.active ?? null],
  );
}

// Knowledge listed under a specific scope. topicId is required when scope is
// topic and must be null when scope is base.
export async function listKnowledgeByScope(pool, { scope, topicId = null }) {
  const res = await pool.query(
    `select id, title, content, source, active, created_at, updated_at
     from knowledge_base
     where scope = $1
       and ((topic_id is null and $2::bigint is null) or topic_id = $2::bigint)
     order by id desc`,
    [scope, topicId],
  );
  return res.rows;
}

export async function setKnowledgeActive(pool, id, active) {
  await pool.query('update knowledge_base set active = $2 where id = $1', [id, active]);
}

export async function deleteKnowledgeUnit(pool, id) {
  await pool.query('delete from knowledge_base where id = $1', [id]);
}

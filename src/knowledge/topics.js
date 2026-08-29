// Data access for topics. A topic is a service the business offers and doubles
// as an FAQ pack: the pack the bot pulls in when the lead came through this
// service's campaign, or when their message mentions this service by name.

export async function listTopics(pool) {
  const res = await pool.query(
    `select t.id, t.slug, t.name, t.description, t.keywords, t.active, t.created_at,
            (select count(*) from faqs f where f.topic_id = t.id and f.active) as faq_count
     from topics t
     order by t.active desc, t.name`,
  );
  return res.rows;
}

export async function getTopic(pool, id) {
  const res = await pool.query(
    'select id, slug, name, description, keywords, active from topics where id = $1',
    [id],
  );
  return res.rows[0] ?? null;
}

export async function getTopicBySlug(pool, slug) {
  const res = await pool.query(
    'select id, slug, name, description, keywords, active from topics where slug = $1',
    [slug],
  );
  return res.rows[0] ?? null;
}

export async function upsertTopic(pool, { slug, name, description, keywords }) {
  const res = await pool.query(
    `insert into topics (slug, name, description, keywords) values ($1, $2, $3, $4)
     on conflict (slug) do update set
       name = excluded.name,
       description = coalesce(excluded.description, topics.description),
       keywords = coalesce(excluded.keywords, topics.keywords),
       updated_at = now()
     returning id, slug, name, description, keywords, active`,
    [slug, name, description ?? null, keywords ?? null],
  );
  return res.rows[0];
}

// Only fields the caller supplied are changed, so a partial edit from the
// console cannot blank out something it did not show.
export async function updateTopic(pool, id, fields) {
  await pool.query(
    `update topics set
       name = coalesce($2, name),
       description = case when $3::boolean then $4::text else description end,
       keywords = case when $5::boolean then $6::text else keywords end,
       active = coalesce($7, active),
       updated_at = now()
     where id = $1`,
    [
      id,
      fields.name ?? null,
      'description' in fields,
      fields.description ?? null,
      'keywords' in fields,
      fields.keywords ?? null,
      fields.active ?? null,
    ],
  );
}

// Removes a pack. Its answers are moved into the common pack (topic_id = null)
// so nothing the client wrote is lost, then the topic row is deleted. Campaigns
// that pointed at this topic are unlinked. Runs in one transaction so a partial
// failure cannot leave the pack half-gone.
export async function deleteTopic(pool, id) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const moved = await client.query(
      'update faqs set topic_id = null where topic_id = $1 returning id',
      [id],
    );
    await client.query('update campaigns set topic_id = null where topic_id = $1', [id]);
    await client.query('delete from topics where id = $1', [id]);
    await client.query('commit');
    return { movedFaqs: moved.rowCount };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

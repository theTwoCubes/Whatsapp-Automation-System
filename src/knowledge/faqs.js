// FAQ storage. Plain rows the client owns and edits directly, grouped into
// packs. A pack is a topic, plus the base pack (topic_id null) that every
// conversation gets. Nothing here embeds or ranks anything: what the bot is
// told is exactly the list below, in the order shown.

const selectColumns = `id, topic_id, question, answer, verbatim, pinned, position,
                       media_asset_id, active, source, created_at, updated_at`;

// pack is 'all', 'base', or a topic id. Kept explicit because a null topic id
// legitimately means the base pack, so it cannot double as "no filter".
export async function listFaqs(pool, { pack = 'all', includeInactive = true } = {}) {
  const where = [];
  const params = [];
  if (pack === 'base') {
    where.push('topic_id is null');
  } else if (pack !== 'all') {
    params.push(pack);
    where.push(`topic_id = $${params.length}`);
  }
  if (!includeInactive) where.push('active = true');

  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const res = await pool.query(
    `select ${selectColumns} from faqs ${clause} order by topic_id nulls first, position, id`,
    params,
  );
  return res.rows;
}

export async function getFaq(pool, id) {
  const res = await pool.query(`select ${selectColumns} from faqs where id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function createFaq(pool, faq, actor = null) {
  const question = (faq.question ?? '').trim();
  const answer = (faq.answer ?? '').trim();
  if (!question || !answer) throw new Error('question and answer are required');

  const client = await pool.connect();
  try {
    await client.query('begin');
    const next = await client.query(
      `select coalesce(max(position), 0) + 1 as position from faqs
       where topic_id is not distinct from $1`,
      [faq.topicId ?? null],
    );
    const res = await client.query(
      `insert into faqs (topic_id, question, answer, verbatim, pinned, position, media_asset_id, active, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${selectColumns}`,
      [
        faq.topicId ?? null,
        question,
        answer,
        Boolean(faq.verbatim),
        Boolean(faq.pinned),
        next.rows[0].position,
        faq.mediaAssetId ?? null,
        faq.active === undefined ? true : Boolean(faq.active),
        faq.source ?? 'manual',
      ],
    );
    const row = res.rows[0];
    await snapshot(client, row, actor);
    await client.query('commit');
    return row;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Only the fields actually supplied are changed, so a partial edit from the
// console cannot blank out something it did not show.
export async function updateFaq(pool, id, fields, actor = null) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const res = await client.query(
      `update faqs set
         question = coalesce($2, question),
         answer = coalesce($3, answer),
         verbatim = coalesce($4, verbatim),
         pinned = coalesce($5, pinned),
         media_asset_id = case when $6::boolean then $7::bigint else media_asset_id end,
         active = coalesce($8, active),
         topic_id = case when $9::boolean then $10::bigint else topic_id end,
         updated_at = now()
       where id = $1
       returning ${selectColumns}`,
      [
        id,
        fields.question ?? null,
        fields.answer ?? null,
        fields.verbatim ?? null,
        fields.pinned ?? null,
        'mediaAssetId' in fields,
        fields.mediaAssetId ?? null,
        fields.active ?? null,
        'topicId' in fields,
        fields.topicId ?? null,
      ],
    );
    const row = res.rows[0] ?? null;
    if (row) await snapshot(client, row, actor);
    await client.query('commit');
    return row;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteFaq(pool, id) {
  await pool.query('delete from faqs where id = $1', [id]);
}

// Applies a client supplied order within one pack in a single transaction, so
// a half applied reorder cannot leave two entries fighting over a position.
export async function reorderFaqs(pool, orderedIds) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (let i = 0; i < orderedIds.length; i += 1) {
      await client.query('update faqs set position = $2, updated_at = now() where id = $1', [orderedIds[i], i + 1]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Case insensitive substring search across question and answer. At this scale
// a plain ILIKE is fast enough, and unlike a similarity match it is easy for
// the client to reason about: what you see in the list is what matched.
export async function searchFaqs(pool, query, { limit = 100 } = {}) {
  const q = (query || '').trim();
  if (!q) return [];
  const res = await pool.query(
    `select f.id, f.topic_id, f.question, f.answer, f.verbatim, f.pinned, f.position,
            f.media_asset_id, f.active, f.source, f.created_at, f.updated_at,
            t.name as topic_name
     from faqs f
     left join topics t on t.id = f.topic_id
     where f.question ilike $1 or f.answer ilike $1
     order by f.active desc, f.topic_id nulls first, f.position, f.id
     limit $2`,
    [`%${q}%`, limit],
  );
  return res.rows;
}

// Bulk activate, deactivate or delete, wrapped in one transaction so a partial
// success cannot leave the list in a half updated state. Every write is still
// snapshotted, except delete which cascades the history away with the row.
export async function bulkUpdateFaqs(pool, ids, action, actor = null) {
  if (!Array.isArray(ids) || ids.length === 0) return { affected: 0 };
  const client = await pool.connect();
  try {
    await client.query('begin');

    let affected = 0;
    if (action === 'delete') {
      const res = await client.query('delete from faqs where id = any($1)', [ids]);
      affected = res.rowCount;
    } else if (action === 'activate' || action === 'deactivate') {
      const value = action === 'activate';
      const rows = (
        await client.query(
          `update faqs set active = $2, updated_at = now() where id = any($1) returning id, question, answer, verbatim`,
          [ids, value],
        )
      ).rows;
      for (const row of rows) {
        await client.query(
          'insert into faq_versions (faq_id, question, answer, verbatim, actor) values ($1, $2, $3, $4, $5)',
          [row.id, row.question, row.answer, row.verbatim, actor],
        );
      }
      affected = rows.length;
    } else {
      throw new Error(`unknown bulk action: ${action}`);
    }

    await client.query('commit');
    return { affected };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function listFaqVersions(pool, faqId, limit = 50) {
  const res = await pool.query(
    `select id, faq_id, question, answer, verbatim, actor, created_at
     from faq_versions where faq_id = $1 order by id desc limit $2`,
    [faqId, limit],
  );
  return res.rows;
}

// Restores an earlier wording. The restore is itself snapshotted, so rolling
// back is an ordinary edit in the history rather than a gap in it.
export async function rollbackFaq(pool, versionId, actor = null) {
  const version = (
    await pool.query('select faq_id, question, answer, verbatim from faq_versions where id = $1', [versionId])
  ).rows[0];
  if (!version) throw new Error('version not found');
  return updateFaq(
    pool,
    version.faq_id,
    { question: version.question, answer: version.answer, verbatim: version.verbatim },
    actor,
  );
}

// The packs the bot can be given, with how much is in each. The base pack is
// listed first because it is always included.
export async function listPacks(pool) {
  const res = await pool.query(
    `select t.id as topic_id, t.slug, t.name, t.description,
            count(f.id) filter (where f.active) as faq_count
     from topics t
     left join faqs f on f.topic_id = t.id
     where t.active = true
     group by t.id
     order by t.name`,
  );
  const base = await pool.query('select count(*) as faq_count from faqs where topic_id is null and active = true');
  return [
    { topic_id: null, slug: 'base', name: 'Base', description: 'Shared answers every conversation can use', faq_count: Number(base.rows[0].faq_count) },
    ...res.rows.map((r) => ({ ...r, faq_count: Number(r.faq_count) })),
  ];
}

async function snapshot(client, row, actor) {
  await client.query(
    'insert into faq_versions (faq_id, question, answer, verbatim, actor) values ($1, $2, $3, $4, $5)',
    [row.id, row.question, row.answer, row.verbatim, actor],
  );
}

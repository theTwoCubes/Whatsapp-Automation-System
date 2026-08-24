// Data access for leads and messages. Plain SQL over a pg pool, no ORM.

// Records an inbound message and everything attached to it: the campaign it came
// from (if the lead arrived via a click to WhatsApp ad), the contact, and the
// conversation. Runs in one transaction. Returns isNew=false when the message id
// was already stored, which is how we drop Meta's webhook retries.
export async function recordInbound(pool, m) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    let campaignId = null;
    const ref = m.referral;
    if (ref && ref.source_id) {
      const res = await client.query(
        `insert into campaigns (source_id, source_type, source_url, headline, body)
         values ($1, $2, $3, $4, $5)
         on conflict (source_id) do update set
           source_type = coalesce(excluded.source_type, campaigns.source_type),
           source_url = coalesce(excluded.source_url, campaigns.source_url),
           headline = coalesce(excluded.headline, campaigns.headline),
           body = coalesce(excluded.body, campaigns.body)
         returning id`,
        [ref.source_id, ref.source_type ?? null, ref.source_url ?? null, ref.headline ?? null, ref.body ?? null],
      );
      campaignId = res.rows[0].id;
    }

    const contact = await client.query(
      `insert into contacts (wa_id, name, first_campaign_id)
       values ($1, $2, $3)
       on conflict (wa_id) do update set
         name = coalesce(excluded.name, contacts.name),
         first_campaign_id = coalesce(contacts.first_campaign_id, excluded.first_campaign_id),
         last_seen_at = now()
       returning id`,
      [m.waId, m.name ?? null, campaignId],
    );
    const contactId = contact.rows[0].id;

    const conversation = await client.query(
      `insert into conversations (contact_id, campaign_id, window_expires_at)
       values ($1, $2, now() + interval '24 hours')
       on conflict (contact_id) do update set
         campaign_id = coalesce(conversations.campaign_id, excluded.campaign_id),
         window_expires_at = now() + interval '24 hours',
         updated_at = now()
       returning id, state`,
      [contactId, campaignId],
    );
    const conversationId = conversation.rows[0].id;
    const state = conversation.rows[0].state;

    const inserted = await client.query(
      `insert into messages (conversation_id, wa_message_id, direction, type, body, referral_campaign_id, raw)
       values ($1, $2, 'inbound', $3, $4, $5, $6)
       on conflict (wa_message_id) do nothing
       returning id`,
      [conversationId, m.waMessageId, m.type ?? 'text', m.body ?? null, campaignId, m.raw ? JSON.stringify(m.raw) : null],
    );

    await client.query('commit');
    return { isNew: inserted.rowCount > 0, conversationId, contactId, state, campaignId };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function recordOutbound(pool, o) {
  await pool.query(
    `insert into messages (conversation_id, wa_message_id, direction, type, body, status)
     values ($1, $2, 'outbound', $3, $4, 'sent')
     on conflict (wa_message_id) do nothing`,
    [o.conversationId, o.waMessageId, o.type ?? 'text', o.body ?? null],
  );
}

export async function updateStatus(pool, s) {
  await pool.query('update messages set status = $2 where wa_message_id = $1', [s.waMessageId, s.status]);
}

// Recent messages for a conversation in chronological order, for the AI context.
export async function getConversationHistory(pool, conversationId, limit = 12) {
  const res = await pool.query(
    `select direction, body from messages
     where conversation_id = $1 and body is not null
     order by created_at desc, id desc
     limit $2`,
    [conversationId, limit],
  );
  return res.rows.reverse();
}

export async function getActiveKnowledge(pool) {
  const res = await pool.query('select title, content from knowledge_base where active = true order by id');
  return res.rows;
}

// Cancels any pending follow ups for a conversation and schedules a fresh set
// from now. Called whenever a lead is active, so the clock resets on each reply.
export async function scheduleDrips(pool, conversationId, steps) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "update drip_jobs set status = 'cancelled' where conversation_id = $1 and status = 'pending'",
      [conversationId],
    );
    for (const s of steps) {
      await client.query(
        `insert into drip_jobs (conversation_id, step, template_name, run_at)
         values ($1, $2, $3, now() + make_interval(days => $4))`,
        [conversationId, s.step, s.template, s.days],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelDrips(pool, conversationId) {
  await pool.query(
    "update drip_jobs set status = 'cancelled' where conversation_id = $1 and status = 'pending'",
    [conversationId],
  );
}

// Follow ups that are due and whose conversation is still owned by the bot.
export async function dueDrips(pool, limit = 20) {
  const res = await pool.query(
    `select d.id, d.conversation_id, d.step, d.template_name, ct.wa_id
     from drip_jobs d
     join conversations c on c.id = d.conversation_id
     join contacts ct on ct.id = c.contact_id
     where d.status = 'pending' and d.run_at <= now() and c.state = 'bot'
     order by d.run_at
     limit $1`,
    [limit],
  );
  return res.rows;
}

export async function markDrip(pool, id, status) {
  await pool.query('update drip_jobs set status = $2 where id = $1', [id, status]);
}

// Console side reads and writes.

export async function getAgentByEmail(pool, email) {
  const res = await pool.query('select id, email, name, password_hash from agents where email = $1', [email]);
  return res.rows[0] ?? null;
}

export async function createAgent(pool, a) {
  await pool.query(
    'insert into agents (email, name, password_hash) values ($1, $2, $3) on conflict (email) do nothing',
    [a.email, a.name ?? null, a.passwordHash],
  );
}

export async function listConversations(pool) {
  const res = await pool.query(
    `select c.id, c.state, c.assignee, c.window_expires_at,
            ct.wa_id, ct.name, ca.headline as campaign,
            m.body as last_message, m.created_at as last_at
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     left join lateral (
       select body, created_at from messages
       where conversation_id = c.id order by created_at desc, id desc limit 1
     ) m on true
     order by m.created_at desc nulls last
     limit 200`,
  );
  return res.rows;
}

export async function getConversationById(pool, id) {
  const res = await pool.query(
    `select c.id, c.state, c.assignee, c.window_expires_at, ct.wa_id, ct.name
     from conversations c join contacts ct on ct.id = c.contact_id
     where c.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function getConversationMessages(pool, id, limit = 200) {
  const res = await pool.query(
    `select id, direction, type, body, status, created_at
     from messages where conversation_id = $1
     order by created_at, id limit $2`,
    [id, limit],
  );
  return res.rows;
}

export async function listTemplates(pool) {
  const res = await pool.query(
    "select name, language, category, body, status from templates where active = true and (status is null or status = 'APPROVED') order by name",
  );
  return res.rows;
}

// Upserts the templates pulled from Meta so the console shows what can actually
// be sent, with their live approval status.
export async function syncTemplates(pool, templates) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const t of templates) {
      await client.query(
        `insert into templates (name, language, category, body, status)
         values ($1, $2, $3, $4, $5)
         on conflict (name) do update set
           language = excluded.language,
           category = excluded.category,
           body = excluded.body,
           status = excluded.status`,
        [t.name, t.language ?? 'en', t.category ?? null, t.body ?? null, t.status ?? null],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function markAgentReplied(pool, conversationId) {
  await pool.query('update conversations set last_agent_at = now() where id = $1', [conversationId]);
}

// Human owned conversations where the lead is waiting (the newest message is
// inbound) and no agent has replied within the resume window. These get handed
// back to the bot automatically.
// Settings, knowledge base, agents, media and overview for the admin console.

export async function setSettings(pool, entries) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const [key, value] of Object.entries(entries)) {
      await client.query(
        `insert into settings (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, value == null ? null : String(value)],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function listKnowledge(pool) {
  return (await pool.query('select id, title, content, active from knowledge_base order by id')).rows;
}

export async function addKnowledge(pool, { title, content }) {
  const r = await pool.query('insert into knowledge_base (title, content) values ($1, $2) returning id', [title, content]);
  return r.rows[0].id;
}

export async function updateKnowledge(pool, id, { title, content, active }) {
  await pool.query(
    `update knowledge_base set
       title = coalesce($2, title),
       content = coalesce($3, content),
       active = coalesce($4, active)
     where id = $1`,
    [id, title ?? null, content ?? null, active ?? null],
  );
}

export async function deleteKnowledge(pool, id) {
  await pool.query('delete from knowledge_base where id = $1', [id]);
}

export async function listAgents(pool) {
  return (await pool.query('select id, email, name, created_at from agents order by id')).rows;
}

export async function deleteAgent(pool, id) {
  await pool.query('delete from agents where id = $1', [id]);
}

export async function addAudit(pool, entry) {
  await pool.query('insert into audit_log (actor, action, target, detail) values ($1, $2, $3, $4)', [
    entry.actor ?? null,
    entry.action,
    entry.target ?? null,
    entry.detail ?? null,
  ]);
}

export async function listAudit(pool, limit = 100) {
  return (await pool.query('select id, actor, action, target, detail, created_at from audit_log order by id desc limit $1', [limit])).rows;
}

export async function overview(pool) {
  const r = await pool.query(
    `select
       (select count(*) from contacts) as leads,
       (select count(*) from campaigns) as campaigns,
       (select count(*) from conversations where state = 'bot') as bot_chats,
       (select count(*) from conversations where state = 'human') as human_chats,
       (select count(*) from messages where direction = 'inbound') as inbound,
       (select count(*) from messages where direction = 'outbound') as outbound`,
  );
  return r.rows[0];
}

export async function addMediaAsset(pool, a) {
  const r = await pool.query(
    'insert into media_assets (meta_media_id, filename, mime_type, kind, caption) values ($1, $2, $3, $4, $5) returning id',
    [a.metaMediaId ?? null, a.filename ?? null, a.mimeType ?? null, a.kind, a.caption ?? null],
  );
  return r.rows[0].id;
}

export async function listMediaAssets(pool) {
  return (
    await pool.query(
      'select id, meta_media_id, filename, mime_type, kind, caption, created_at from media_assets order by id desc limit 100',
    )
  ).rows;
}

export async function getMessageRaw(pool, id) {
  return (await pool.query('select id, type, raw from messages where id = $1', [id])).rows[0] ?? null;
}

export async function getMediaAsset(pool, id) {
  return (
    await pool.query('select id, meta_media_id, filename, mime_type, kind, caption from media_assets where id = $1', [id])
  ).rows[0] ?? null;
}

export async function conversationsToResume(pool, minutes) {
  const res = await pool.query(
    `select c.id, ct.wa_id
     from conversations c
     join contacts ct on ct.id = c.contact_id
     where c.state = 'human'
       and coalesce(c.last_agent_at, c.assigned_at) < now() - make_interval(mins => $1)
       and (
         select direction from messages m
         where m.conversation_id = c.id
         order by m.created_at desc, m.id desc
         limit 1
       ) = 'inbound'`,
    [minutes],
  );
  return res.rows;
}

export async function setConversationState(pool, conversationId, state, assignee = null) {
  await pool.query('update conversations set state = $2, assignee = $3, updated_at = now() where id = $1', [
    conversationId,
    state,
    assignee,
  ]);
}

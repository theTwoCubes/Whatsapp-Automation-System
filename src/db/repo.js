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
       returning id, state, campaign_id`,
      [contactId, campaignId],
    );
    const conversationId = conversation.rows[0].id;
    const state = conversation.rows[0].state;
    const effectiveCampaignId = conversation.rows[0].campaign_id;

    // Resolve the topic from the linked campaign so the caller can bias
    // knowledge retrieval by service.
    let topicId = null;
    if (effectiveCampaignId) {
      const t = await client.query('select topic_id from campaigns where id = $1', [effectiveCampaignId]);
      topicId = t.rows[0]?.topic_id ?? null;
    }

    // sent_at is the lead's send time from the WhatsApp payload. If the
    // webhook is delivered late (server was down, retry), created_at will be
    // now and sent_at will still show the original send time.
    const sentAt = m.sentAt ? new Date(m.sentAt) : null;
    const inserted = await client.query(
      `insert into messages (conversation_id, wa_message_id, direction, type, body, referral_campaign_id, raw, sent_at)
       values ($1, $2, 'inbound', $3, $4, $5, $6, coalesce($7, now()))
       on conflict (wa_message_id) do nothing
       returning id`,
      [conversationId, m.waMessageId, m.type ?? 'text', m.body ?? null, campaignId, m.raw ? JSON.stringify(m.raw) : null, sentAt],
    );

    await client.query('commit');
    return { isNew: inserted.rowCount > 0, conversationId, contactId, state, campaignId, topicId };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function recordOutbound(pool, o) {
  await pool.query(
    `insert into messages (conversation_id, wa_message_id, direction, type, body, status, media_asset_id)
     values ($1, $2, 'outbound', $3, $4, 'sent', $5)
     on conflict (wa_message_id) do nothing`,
    [o.conversationId, o.waMessageId, o.type ?? 'text', o.body ?? null, o.mediaAssetId ?? null],
  );
}

// The current state of a conversation, checked right before the bot actually
// replies so a handoff that happened while a reply was in flight (a debounce
// window, an in flight ai call) is respected instead of raced past.
export async function getConversationState(pool, conversationId) {
  const res = await pool.query('select state from conversations where id = $1', [conversationId]);
  return res.rows[0]?.state ?? null;
}

export async function markInboundRead(pool, conversationId) {
  const res = await pool.query(
    `update messages set status = 'read' 
     where conversation_id = $1 and direction = 'inbound' and status is null 
     returning id, wa_message_id`
    , [conversationId]
  );
  if (res.rows.length > 0) {
    const sorted = res.rows.sort((a, b) => a.id - b.id);
    return sorted[sorted.length - 1].wa_message_id;
  }
  return null;
}

// A record of every time a chat left the bot for a person. Written once per
// handoff, not overwritten, so the weekly refinement pass can walk them by
// id and see exactly what the bot could not answer. source picks apart the
// kind of handoff: 'ai' means the model itself judged the chat needed a
// person, which is the only signal that indicates a real knowledge gap.
export async function recordHandoff(pool, { conversationId, source, reason = null, topicId = null }) {
  const messageIdRow = await pool.query(
    `select id from messages where conversation_id = $1 and direction = 'inbound'
     order by created_at desc, id desc limit 1`,
    [conversationId],
  );
  const messageId = messageIdRow.rows[0]?.id ?? null;
  await pool.query(
    `insert into handoff_events (conversation_id, message_id, source, reason, topic_id)
     values ($1, $2, $3, $4, $5)`,
    [conversationId, messageId, source, reason, topicId],
  );
}

// Packs the conversation has pulled in on top of the campaign's own pack.
export async function getActivePackIds(pool, conversationId) {
  const res = await pool.query('select active_pack_ids from conversations where id = $1', [conversationId]);
  return (res.rows[0]?.active_pack_ids ?? []).map((id) => Number(id));
}

// Adds pack ids to the sticky set for this conversation, keeping the order
// they came in and ignoring anything already there. Done in a single update
// so two concurrent replies cannot lose each other's additions.
export async function addActivePackIds(pool, conversationId, ids) {
  if (!ids || ids.length === 0) return;
  await pool.query(
    `update conversations set
       active_pack_ids = (
         select coalesce(array_agg(distinct x order by x), '{}')
         from unnest(active_pack_ids || $2::bigint[]) as x
       )
     where id = $1`,
    [conversationId, ids],
  );
}

export async function updateStatus(pool, s) {
  await pool.query(
    `update messages set status = $2 
     where wa_message_id = $1 
       and (
         ($2 = 'read') or
         ($2 = 'delivered' and status is distinct from 'read') or
         ($2 = 'sent' and status is distinct from 'read' and status is distinct from 'delivered') or
         ($2 = 'failed')
       )`,
    [s.waMessageId, s.status]
  );
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

// Who the lead is and where they are in the funnel, so the prompt can be
// personal without guessing: name if known, the linked service (via the
// campaign's topic), and how many messages they have sent so far.
export async function getConversationContext(pool, conversationId) {
  const res = await pool.query(
    `select ct.name as contact_name, c.created_at,
            t.name as topic_name,
            (select count(*) from messages m where m.conversation_id = c.id and m.direction = 'inbound') as turn_count
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     left join topics t on t.id = ca.topic_id
     where c.id = $1`,
    [conversationId],
  );
  return res.rows[0] ?? null;
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

// Atomically claims the follow ups that are due and whose conversation is still
// owned by the bot, marking them 'sending' so another running instance cannot
// pick up the same job. Uses SKIP LOCKED so concurrent schedulers never block
// or double send.
export async function claimDueDrips(pool, limit = 20) {
  const res = await pool.query(
    `with due as (
       select d.id
       from drip_jobs d
       join conversations c on c.id = d.conversation_id
       where d.status = 'pending' and d.run_at <= now() and c.state = 'bot'
       order by d.run_at
       limit $1
       for update skip locked
     ),
     claimed as (
       update drip_jobs set status = 'sending'
       where id in (select id from due)
       returning id, conversation_id, step, template_name
     )
     select cl.id, cl.conversation_id, cl.step, cl.template_name, ct.wa_id
     from claimed cl
     join conversations c on c.id = cl.conversation_id
     join contacts ct on ct.id = c.contact_id`,
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

export async function listConversations(pool, { includeArchived = false } = {}) {
  const res = await pool.query(
    `select c.id, c.state, c.assignee, c.window_expires_at, c.handoff_reason,
            c.pinned_at, c.archived_at, c.muted_until,
            ct.wa_id, ct.name, ca.headline as campaign,
            m.body as last_message, coalesce(m.sent_at, m.created_at) as last_at,
            (select count(*) from messages um where um.conversation_id = c.id and um.direction = 'inbound' and um.created_at > coalesce(c.last_read_at, '1970-01-01'))::int as unread_count
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     left join lateral (
       select body, sent_at, created_at from messages
       where conversation_id = c.id order by coalesce(sent_at, created_at) desc, id desc limit 1
     ) m on true
     where ($1::boolean and c.archived_at is not null)
        or (not $1::boolean and c.archived_at is null)
     order by (c.pinned_at is not null) desc, c.pinned_at desc nulls last,
              coalesce(m.sent_at, m.created_at) desc nulls last
     limit 200`,
    [includeArchived],
  );
  return res.rows;
}

export async function setConversationFlag(pool, conversationId, flag, value) {
  const columns = { pin: 'pinned_at', archive: 'archived_at' };
  const column = columns[flag];
  if (!column) throw new Error('unknown flag');
  // value === true sets to now(), false clears.
  const sql = value
    ? `update conversations set ${column} = now(), updated_at = now() where id = $1`
    : `update conversations set ${column} = null, updated_at = now() where id = $1`;
  await pool.query(sql, [conversationId]);
}

export async function muteConversation(pool, conversationId, until) {
  // until is a Date (or null to unmute).
  await pool.query(
    `update conversations set muted_until = $2, updated_at = now() where id = $1`,
    [conversationId, until],
  );
}

export async function getConversationById(pool, id) {
  await pool.query('update conversations set last_read_at = now() where id = $1', [id]);
  const res = await pool.query(
    `select c.id, c.state, c.assignee, c.window_expires_at, c.handoff_reason, ct.wa_id, ct.name
     from conversations c join contacts ct on ct.id = c.contact_id
     where c.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function getConversationMessages(pool, id, limit = 200) {
  const res = await pool.query(
    `select id, direction, type, body, status, created_at,
            coalesce(sent_at, created_at) as sent_at,
            coalesce(
              raw->'document'->>'filename',
              raw->'image'->>'filename',
              raw->'video'->>'filename',
              raw->'audio'->>'filename'
            ) as media_filename,
            coalesce(
              raw->'document'->>'mime_type',
              raw->'image'->>'mime_type',
              raw->'video'->>'mime_type',
              raw->'audio'->>'mime_type',
              raw->'voice'->>'mime_type',
              raw->'sticker'->>'mime_type'
            ) as media_mime
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
    await client.query('update templates set active = false');
    for (const t of templates) {
      await client.query(
        `insert into templates (name, language, category, body, status, active)
         values ($1, $2, $3, $4, $5, true)
         on conflict (name) do update set
           language = excluded.language,
           category = excluded.category,
           body = excluded.body,
           status = excluded.status,
           active = true`,
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

export async function metrics(pool) {
  const r = await pool.query(
    `select
       (select count(*) from contacts) as leads,
       (select count(*) from conversations where state = 'bot') as bot_chats,
       (select count(*) from conversations where state = 'human') as human_chats,
       (select count(*) from conversations where state = 'pending') as pending_chats,
       (select count(*) from messages where direction = 'inbound') as inbound,
       (select count(*) from messages where direction = 'outbound') as outbound,
       (select count(*) from drip_jobs where status = 'pending') as drip_pending`,
  );
  return r.rows[0];
}

// Stats per Meta ad campaign, plus a separate organic bucket for leads that
// arrived with no click to whatsapp referral at all. This is how the console
// answers "where are our leads actually coming from".
export async function campaignStats(pool) {
  const campaigns = await pool.query(
    `select ca.id, ca.headline, ca.source_type, ca.source_url, ca.topic_id, t.name as topic_name, ca.created_at,
            count(distinct c.id) as leads,
            count(distinct c.id) filter (where c.state = 'bot') as bot_chats,
            count(distinct c.id) filter (where c.state = 'human') as human_chats,
            count(distinct c.id) filter (where c.state = 'pending') as pending_chats,
            count(m.id) filter (where m.direction = 'inbound') as inbound,
            count(m.id) filter (where m.direction = 'outbound') as outbound,
            max(m.created_at) as last_activity
     from campaigns ca
     left join topics t on t.id = ca.topic_id
     left join conversations c on c.campaign_id = ca.id
     left join messages m on m.conversation_id = c.id
     group by ca.id, t.name
     order by last_activity desc nulls last, ca.created_at desc`,
  );

  const organic = await pool.query(
    `select
       count(distinct c.id) as leads,
       count(distinct c.id) filter (where c.state = 'bot') as bot_chats,
       count(distinct c.id) filter (where c.state = 'human') as human_chats,
       count(distinct c.id) filter (where c.state = 'pending') as pending_chats,
       count(m.id) filter (where m.direction = 'inbound') as inbound,
       count(m.id) filter (where m.direction = 'outbound') as outbound,
       max(m.created_at) as last_activity
     from conversations c
     left join messages m on m.conversation_id = c.id
     where c.campaign_id is null`,
  );

  return { campaigns: campaigns.rows, organic: organic.rows[0] };
}

export async function linkCampaignTopic(pool, campaignId, topicId) {
  await pool.query('update campaigns set topic_id = $2 where id = $1', [campaignId, topicId]);
}

export async function overview(pool) {
  const r = await pool.query(
    `select
       (select count(*) from contacts) as leads,
       (select count(*) from campaigns) as campaigns,
       (select count(*) from conversations where state = 'bot') as bot_chats,
       (select count(*) from conversations where state = 'human') as human_chats,
       (select count(*) from conversations where state = 'pending') as pending_chats,
       (select count(*) from messages where direction = 'inbound') as inbound,
       (select count(*) from messages where direction = 'outbound') as outbound`
  );

  const leadsHistory = await pool.query(
    `select to_char(first_seen_at, 'YYYY-MM-DD') as date, count(*)::int as count
     from contacts
     where first_seen_at >= now() - interval '30 days'
     group by date
     order by date asc`
  );

  return {
    ...r.rows[0],
    leads_per_day: leadsHistory.rows,
  };
}

export async function addMediaAsset(pool, a) {
  const r = await pool.query(
    `insert into media_assets (meta_media_id, filename, mime_type, kind, caption, topic_id, description)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      a.metaMediaId ?? null,
      a.filename ?? null,
      a.mimeType ?? null,
      a.kind,
      a.caption ?? null,
      a.topicId ?? null,
      a.description ?? null,
    ],
  );
  return r.rows[0].id;
}

export async function listMediaAssets(pool, { topicId = null } = {}) {
  if (topicId) {
    return (
      await pool.query(
        `select id, meta_media_id, filename, mime_type, kind, caption, topic_id, description, created_at
         from media_assets where topic_id = $1 order by id desc limit 100`,
        [topicId],
      )
    ).rows;
  }
  return (
    await pool.query(
      `select id, meta_media_id, filename, mime_type, kind, caption, topic_id, description, created_at
       from media_assets order by id desc limit 100`,
    )
  ).rows;
}

export async function deleteMediaAsset(pool, id) {
  await pool.query('delete from media_assets where id = $1', [id]);
}

// Whether this exact asset already went out in this conversation recently, so
// the bot can lean away from resending it without being hard blocked, in case
// the lead genuinely asks again later.
export async function wasMediaSentRecently(pool, conversationId, mediaAssetId, minutes = 180) {
  const res = await pool.query(
    `select exists(
       select 1 from messages
       where conversation_id = $1 and media_asset_id = $2 and direction = 'outbound'
         and created_at > now() - make_interval(mins => $3)
     ) as sent`,
    [conversationId, mediaAssetId, minutes],
  );
  return res.rows[0].sent;
}

export async function getMessageRaw(pool, id) {
  return (await pool.query('select id, type, raw from messages where id = $1', [id])).rows[0] ?? null;
}

export async function getMediaAsset(pool, id) {
  return (
    await pool.query('select id, meta_media_id, filename, mime_type, kind, caption from media_assets where id = $1', [id])
  ).rows[0] ?? null;
}

// Stalled chats to hand back to the bot: either an agent has gone quiet on a
// chat they own, or nobody accepted a pending handoff in time. Either way the
// lead should not be left waiting indefinitely.
export async function conversationsToResume(pool, minutes) {
  const res = await pool.query(
    `select c.id, ct.wa_id, ca.topic_id
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     where c.state in ('human', 'pending')
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

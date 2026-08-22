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

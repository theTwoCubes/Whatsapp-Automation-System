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
         -- A new inbound pulls the chat back out of the archive or soft
         -- delete, the way WhatsApp does. A deleted chat comes back fresh
         -- under the bot. Mute is intentionally left alone.
         archived_at = null,
         deleted_at = null,
         state = case when conversations.deleted_at is not null then 'bot' else conversations.state end,
         assignee = case when conversations.deleted_at is not null then null else conversations.assignee end,
         handoff_reason = case when conversations.deleted_at is not null then null else conversations.handoff_reason end,
         blocked_at = case when conversations.deleted_at is not null then null else conversations.blocked_at end,
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
    return {
      isNew: inserted.rowCount > 0,
      conversationId,
      contactId,
      state,
      campaignId,
      topicId,
      messageId: inserted.rows[0]?.id ?? null,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Lets an agent start a conversation with a number that has never messaged
// in, from the console's Compose button. No window_expires_at is set (there
// has been no inbound message yet) so the thread opens exactly like any
// other outside-the-window chat - the composer only offers an approved
// template, same as it already does everywhere else. Reuses an existing
// conversation for that number if there is one instead of creating a
// duplicate, and revives it out of the archive/soft-delete the same way a
// real inbound message would. business/email/topicId are optional, used by
// bulk send where the client pastes in more than just a name and number.
export async function findOrCreateComposeConversation(pool, { waId, name, business = null, email = null, topicId = null }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const contact = await client.query(
      `insert into contacts (wa_id, name, business, email)
       values ($1, $2, $3, $4)
       on conflict (wa_id) do update set
         name = coalesce(contacts.name, excluded.name),
         business = coalesce(contacts.business, excluded.business),
         email = coalesce(contacts.email, excluded.email),
         last_seen_at = now()
       returning id`,
      [waId, name ?? null, business, email],
    );
    const contactId = contact.rows[0].id;

    // origin is only ever set on insert, never on conflict - a number we
    // reach out to that turns out to already have an organic ('lead')
    // conversation must not be relabelled as business-initiated.
    const conversation = await client.query(
      `insert into conversations (contact_id, last_topic_id, origin)
       values ($1, $2, 'business')
       on conflict (contact_id) do update set
         archived_at = null,
         deleted_at = null,
         state = case when conversations.deleted_at is not null then 'bot' else conversations.state end,
         assignee = case when conversations.deleted_at is not null then null else conversations.assignee end,
         last_topic_id = coalesce(excluded.last_topic_id, conversations.last_topic_id),
         updated_at = now()
       returning id`,
      [contactId, topicId],
    );
    await client.query('commit');
    return conversation.rows[0].id;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Parks a webhook change that failed to process, so it can be inspected or
// replayed rather than lost.
export async function deadLetterWebhook(pool, payload, error) {
  await pool.query(
    'insert into webhook_dead_letter (payload, error) values ($1, $2)',
    [JSON.stringify(payload), error ?? null],
  );
}

export async function recordOutbound(pool, o) {
  // Only outbound replies carry a context (the quoted message). Store it under
  // the same raw->context->id shape WhatsApp uses for inbound replies so the
  // thread can resolve both directions the same way. A reaction is stored the
  // same way inbound reactions arrive from the webhook (raw->reaction), so
  // both directions resolve through the one shape.
  const raw = o.context
    ? JSON.stringify({ context: { id: o.context.message_id } })
    : o.reaction
      ? JSON.stringify({ reaction: { message_id: o.reaction.messageId, emoji: o.reaction.emoji } })
      : null;
  await pool.query(
    `insert into messages (conversation_id, wa_message_id, direction, type, body, status, media_asset_id, raw, ai_ms, meta_ms)
     values ($1, $2, 'outbound', $3, $4, 'sent', $5, $6, $7, $8)
     on conflict (wa_message_id) do nothing`,
    [o.conversationId, o.waMessageId, o.type ?? 'text', o.body ?? null, o.mediaAssetId ?? null, raw,
     o.aiMs ?? null, o.metaMs ?? null],
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
export async function recordHandoff(pool, { conversationId, source, reason = null, reasonCategory = null, topicId = null }) {
  const messageIdRow = await pool.query(
    `select id from messages where conversation_id = $1 and direction = 'inbound'
     order by created_at desc, id desc limit 1`,
    [conversationId],
  );
  const messageId = messageIdRow.rows[0]?.id ?? null;
  await pool.query(
    `insert into handoff_events (conversation_id, message_id, source, reason, reason_category, topic_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [conversationId, messageId, source, reason, reasonCategory ?? null, topicId],
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

// Overwritten, never merged - unlike active_pack_ids (a deduplicated,
// id-sorted set with no notion of order), this always reflects whichever
// service the conversation most recently engaged, for the console's service
// filter. Left alone for a campaign-linked lead, whose service comes from
// the campaign itself and is not meant to change.
export async function setLastTopicId(pool, conversationId, topicId) {
  await pool.query('update conversations set last_topic_id = $2 where id = $1', [conversationId, topicId]);
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
    `select direction, body, attachment_context from messages
     where conversation_id = $1 and body is not null
       and created_at > coalesce((select cleared_at from conversations where id = $1), '1970-01-01')
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
    `select ct.name as contact_name, ct.business as contact_business, ct.email as contact_email,
            ct.address as contact_address, ct.lead_details as contact_lead_details,
            c.created_at, c.reply_language, c.introduced_at,
            t.name as topic_name,
            (select count(*) from messages m where m.conversation_id = c.id and m.direction = 'inbound'
             and m.created_at > coalesce(c.cleared_at, '1970-01-01')) as turn_count
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     left join topics t on t.id = ca.topic_id
     where c.id = $1`,
    [conversationId],
  );
  return res.rows[0] ?? null;
}

// Overwritten every reply so the AI's next turn has a running anchor for
// which language it was using, instead of re-guessing from scratch within a
// limited history window each time.
export async function setReplyLanguage(pool, conversationId, language) {
  await pool.query('update conversations set reply_language = $2 where id = $1', [conversationId, language]);
}

// Marks that the bot has introduced itself in this chat, so the prompt never
// tells it to do so twice. Once set it never clears - a cleared chat still
// counts as an already-met lead, not a stranger.
export async function markIntroduced(pool, conversationId) {
  await pool.query('update conversations set introduced_at = now() where id = $1 and introduced_at is null', [conversationId]);
}

// Facts the AI picked up mid-conversation and never has to ask for again.
// The lead's name comes from their WhatsApp profile already in almost every
// case, so it is only filled in here if that was somehow empty - business and
// email are never collected any other way, so a fresh answer always wins over
// nothing, but never overwrites one already on file (the lead corrects it by
// telling the AI again, not by having every mention overwrite the last).
// details is a free-form bag (requirement, budget, timeline, and anything
// else service-specific) - merged key by key the same way name/business/email
// are: an existing value on file wins, a new value only fills a gap that was
// previously empty. That's why it's `new || existing` and not the other way
// round - in jsonb `||`, the right-hand side wins on a shared key.
export async function setLeadProfile(pool, conversationId, { name, business, email, address, details } = {}) {
  if (!name && !business && !email && !address && (!details || Object.keys(details).length === 0)) return;
  await pool.query(
    `update contacts set
       name = coalesce(contacts.name, $2),
       business = coalesce(contacts.business, $3),
       email = coalesce(contacts.email, $4),
       address = coalesce(contacts.address, $5),
       lead_details = $6::jsonb || contacts.lead_details
     where id = (select contact_id from conversations where id = $1)`,
    [conversationId, name || null, business || null, email || null, address || null, JSON.stringify(details || {})],
  );
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
        `insert into drip_jobs (conversation_id, step, template_name, media_asset_id, run_at)
         values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [conversationId, s.step, s.template, s.mediaAssetId ?? null, s.days],
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

// Opts the contact behind a conversation out of every future drip and bulk
// send, and cancels anything already scheduled. Does not touch their ability
// to message in and get a normal reply - see the migration's comment.
export async function optOutContact(pool, conversationId) {
  await pool.query(
    `update contacts set opted_out_at = now()
     where id = (select contact_id from conversations where id = $1) and opted_out_at is null`,
    [conversationId],
  );
  await cancelDrips(pool, conversationId);
}

// Logs that the lead said they paid, so it shows up in the sidebar and the
// team was pinged - see notifyAgentsOfHandoff's 'payment_claimed' kind. Only
// the first claim in a conversation is timestamped; a lead repeating "I paid"
// on a later turn does not need a second note.
export async function recordPaymentClaimed(pool, conversationId) {
  await pool.query(
    `update contacts set lead_details = jsonb_set(lead_details, '{payment_claimed_at}', to_jsonb(now()::text), true)
     where id = (select contact_id from conversations where id = $1)
       and lead_details->>'payment_claimed_at' is null`,
    [conversationId],
  );
}

export async function isContactOptedOut(pool, conversationId) {
  const res = await pool.query(
    `select ct.opted_out_at from conversations c join contacts ct on ct.id = c.contact_id where c.id = $1`,
    [conversationId],
  );
  return Boolean(res.rows[0]?.opted_out_at);
}

// wa_ids that are opted out, so a bulk send (or any future outreach list)
// can filter them out before queueing rather than after.
export async function filterOptedOutWaIds(pool, waIds) {
  if (waIds.length === 0) return [];
  const res = await pool.query(
    'select wa_id from contacts where wa_id = any($1::text[]) and opted_out_at is not null',
    [waIds],
  );
  return res.rows.map((r) => r.wa_id);
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
       join contacts ct on ct.id = c.contact_id
       where d.status = 'pending' and d.run_at <= now() and c.state = 'bot' and ct.opted_out_at is null
       order by d.run_at
       limit $1
       for update skip locked
     ),
     claimed as (
       update drip_jobs set status = 'sending', updated_at = now()
       where id in (select id from due)
       returning id, conversation_id, step, template_name, media_asset_id
     )
     select cl.id, cl.conversation_id, cl.step, cl.template_name, cl.media_asset_id, ct.wa_id,
            m.meta_media_id, m.kind as media_kind, m.filename as media_filename
     from claimed cl
     join conversations c on c.id = cl.conversation_id
     join contacts ct on ct.id = c.contact_id
     left join media_assets m on m.id = cl.media_asset_id`,
    [limit],
  );
  return res.rows;
}

export async function markDrip(pool, id, status) {
  await pool.query('update drip_jobs set status = $2, updated_at = now() where id = $1', [id, status]);
}

// A job left in 'sending' past this window means the process that claimed it
// died (or lost its connection) before it ever got a response from Meta, not
// that the message went out and only the bookkeeping failed - that case is
// marked 'stuck' instead (see markDripStuck) and deliberately left alone
// here, since retrying a confirmed delivery would double-message the lead.
// Retrying an unconfirmed one is the safer failure mode of the two.
export async function reclaimStuckDrips(pool, staleMinutes = 15) {
  const res = await pool.query(
    `update drip_jobs set status = 'pending', updated_at = now()
     where status = 'sending' and updated_at < now() - make_interval(mins => $1)
     returning id`,
    [staleMinutes],
  );
  return res.rows.map((r) => r.id);
}

// The template was confirmed delivered (Meta returned a wamid) but something
// after that threw before the job could be marked 'sent' - status 'stuck'
// rather than 'failed' so the ordinary retry/reclaim paths never touch it,
// since retrying would resend a message that already reached the lead. This
// needs a person to look at the logs and close it out by hand.
export async function markDripStuck(pool, id) {
  await pool.query("update drip_jobs set status = 'stuck', updated_at = now() where id = $1", [id]);
}

// Bulk send: the client pastes a list of leads, picks a service and an
// approved template, and every recipient becomes one row here. Processed by
// the scheduler in small batches, mirroring the drip job queue above - same
// reasons apply: Meta rate limits, and a crashed process should not lose or
// duplicate sends.

export async function queueBulkSend(pool, batchId, rows, templateName) {
  if (rows.length === 0) return 0;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 7;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    params.push(batchId, r.waId, r.name ?? null, r.business ?? null, r.email ?? null, r.topicId ?? null, templateName);
  });
  const res = await pool.query(
    `insert into bulk_send_jobs (batch_id, wa_id, name, business, email, topic_id, template_name)
     values ${values.join(', ')}
     returning id`,
    params,
  );
  return res.rows.length;
}

export async function claimBulkSendJobs(pool, limit = 20) {
  // A contact can opt out after their bulk send job was already queued but
  // before it went out - marked skipped (not silently left pending forever,
  // and not claimed/sent) so it's still visible in the batch's progress.
  await pool.query(
    `update bulk_send_jobs set status = 'skipped', updated_at = now()
     where status = 'pending'
       and exists (select 1 from contacts ct where ct.wa_id = bulk_send_jobs.wa_id and ct.opted_out_at is not null)`,
  );

  const res = await pool.query(
    `with due as (
       select id from bulk_send_jobs
       where status = 'pending'
       order by id
       limit $1
       for update skip locked
     ),
     claimed as (
       update bulk_send_jobs set status = 'sending', updated_at = now()
       where id in (select id from due)
       returning id, wa_id, name, business, email, topic_id, template_name
     )
     select * from claimed`,
    [limit],
  );
  return res.rows;
}

export async function markBulkSendJob(pool, id, status, { error = null, conversationId = null } = {}) {
  await pool.query(
    `update bulk_send_jobs set status = $2, error = $3, conversation_id = coalesce($4, conversation_id), updated_at = now() where id = $1`,
    [id, status, error, conversationId],
  );
}

// Mirrors reclaimStuckDrips - a job left in 'sending' past this window means
// the process that claimed it died before hearing back from Meta, not that
// the send actually went through (that path marks 'stuck' explicitly instead
// and is deliberately left alone here).
export async function reclaimStuckBulkSendJobs(pool, staleMinutes = 15) {
  const res = await pool.query(
    `update bulk_send_jobs set status = 'pending', updated_at = now()
     where status = 'sending' and updated_at < now() - make_interval(mins => $1)
     returning id`,
    [staleMinutes],
  );
  return res.rows.map((r) => r.id);
}

export async function bulkSendBatchProgress(pool, batchId) {
  const res = await pool.query(
    `select status, count(*)::int as count from bulk_send_jobs where batch_id = $1 group by status`,
    [batchId],
  );
  const byStatus = Object.fromEntries(res.rows.map((r) => [r.status, r.count]));
  const total = res.rows.reduce((n, r) => n + r.count, 0);
  return { total, byStatus };
}

export async function listRecentBulkSendBatches(pool, limit = 20) {
  const res = await pool.query(
    `select j.batch_id, j.template_name, t.name as topic_name,
            min(j.created_at) as started_at, count(*)::int as total,
            count(*) filter (where j.status = 'sent')::int as sent,
            count(*) filter (where j.status in ('failed', 'stuck'))::int as failed,
            count(*) filter (where j.status in ('pending', 'sending'))::int as pending
     from bulk_send_jobs j
     left join topics t on t.id = j.topic_id
     group by j.batch_id, j.template_name, t.name
     order by min(j.created_at) desc
     limit $1`,
    [limit],
  );
  return res.rows;
}

// Console side reads and writes.

export async function getAgentByEmail(pool, email) {
  const res = await pool.query('select id, email, name, password_hash, role, token_version from agents where email = $1', [email]);
  return res.rows[0] ?? null;
}

// Checked on every authenticated request against the token's own embedded
// version - a role change or removal bumps this (or removes the row), which
// invalidates every JWT already issued for that agent immediately instead of
// waiting out its expiry.
export async function getAgentAuthState(pool, id) {
  const res = await pool.query('select role, token_version from agents where id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function createAgent(pool, a) {
  const role = a.role === 'admin' ? 'admin' : 'agent';
  await pool.query(
    'insert into agents (email, name, password_hash, role) values ($1, $2, $3, $4) on conflict (email) do nothing',
    [a.email, a.name ?? null, a.passwordHash, role],
  );
}

// Promote or demote an agent. Used both by the admin console and by the boot
// seed to make sure the ADMIN_EMAIL account is always admin, even if it was
// previously downgraded.
export async function setAgentRole(pool, email, role) {
  if (role !== 'admin' && role !== 'agent') throw new Error('unknown role');
  // Bumping token_version invalidates any JWT already issued to this agent,
  // so a demotion takes effect immediately instead of at token expiry.
  await pool.query('update agents set role = $2, token_version = token_version + 1 where email = $1', [email, role]);
}

export async function listConversations(pool, { includeArchived = false } = {}) {
  const res = await pool.query(
    `select c.id, c.state, c.assignee, c.window_expires_at, c.handoff_reason, c.suggested_agent,
            c.pinned_at, c.archived_at, c.muted_until, c.blocked_at, c.origin,
            ct.wa_id, ct.name, ca.headline as campaign,
            m.body as last_message, m.type as last_message_type,
            coalesce(m.sent_at, m.created_at) as last_at,
            (select count(*) from messages um where um.conversation_id = c.id and um.direction = 'inbound' and um.created_at > coalesce(c.last_read_at, '1970-01-01'))::int as unread_count,
            -- The service this conversation is about, for the console's service
            -- filter. An ad-click lead's campaign topic wins when there is one
            -- and never changes; otherwise it's whichever service the AI most
            -- recently engaged (last_topic_id is overwritten, not merged, so
            -- this reflects what the conversation is about right now rather
            -- than an arbitrary member of the full set it has ever touched).
            coalesce(ca.topic_id, c.last_topic_id) as topic_id,
            t.name as topic_name,
            coalesce((
              select json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color', tg.color) order by tg.name)
              from conversation_tags ctg join tags tg on tg.id = ctg.tag_id
              where ctg.conversation_id = c.id
            ), '[]') as tags
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     left join topics t on t.id = coalesce(ca.topic_id, c.last_topic_id)
     left join lateral (
       -- A reaction is not really "the last message" in any conversational
       -- sense - excluded so it can never hijack the list preview. Also
       -- respects cleared_at so a cleared chat's preview goes back to "No
       -- messages yet" instead of still showing what was just wiped.
       select body, type, sent_at, created_at from messages
       where conversation_id = c.id and type <> 'reaction'
         and created_at > coalesce(c.cleared_at, '1970-01-01')
       order by coalesce(sent_at, created_at) desc, id desc limit 1
     ) m on true
     where c.deleted_at is null and (
          ($1::boolean and c.archived_at is not null)
       or (not $1::boolean and c.archived_at is null)
     )
     order by (c.pinned_at is not null) desc, c.pinned_at desc nulls last,
              coalesce(m.sent_at, m.created_at) desc nulls last
     limit 200`,
    [includeArchived],
  );
  return res.rows;
}

// Everything the client's export needs, one row per lead: every field we've
// saved plus which service they're associated with and where the chat
// currently stands. Not paginated - this is a download, not a list view -
// but capped so a runaway contact base cannot build an unbounded workbook in
// memory. Filters are the same ones the dashboard's lead table uses, so the
// download always matches whatever is on screen when it's clicked.
export async function listContactsForExport(pool, filters = {}) {
  const { where, params } = leadFilterClauses(filters);
  const res = await pool.query(
    `select ct.name, ct.wa_id, ct.email, ct.business, ct.address, ct.lead_details, c.state,
            t.name as topic_name
     from contacts ct
     left join conversations c on c.contact_id = ct.id
     left join campaigns ca on ca.id = c.campaign_id
     left join topics t on t.id = coalesce(ca.topic_id, c.last_topic_id)
     where ${where} and (c.id is null or c.deleted_at is null)
     order by ct.name nulls last, ct.wa_id
     limit 5000`,
    params,
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

// Sets or clears the blocked flag. The caller is responsible for calling the
// Meta block API; this only records our own state so the webhook can ignore
// the lead even if the remote call failed.
export async function setConversationBlocked(pool, conversationId, blocked) {
  await pool.query(
    `update conversations set blocked_at = ${blocked ? 'now()' : 'null'}, updated_at = now() where id = $1`,
    [conversationId],
  );
}

export async function clearChat(pool, conversationId) {
  await pool.query(
    `update conversations set cleared_at = now(), updated_at = now() where id = $1`,
    [conversationId],
  );
}

// Soft delete. Row stays for 30 days so a misclick can be undone, then a
// nightly job removes it for good. Also clears the chat history marker.
export async function softDeleteConversation(pool, conversationId) {
  await pool.query(
    `update conversations set deleted_at = now(), cleared_at = now(), state = 'bot', assignee = null, handoff_reason = null,
     blocked_at = null, archived_at = null, pinned_at = null, updated_at = now() where id = $1`,
    [conversationId],
  );
}

// True when a conversation is blocked, checked in the webhook path so a
// blocked lead's messages are stored but never answered.
export async function isConversationBlocked(pool, conversationId) {
  const res = await pool.query('select blocked_at from conversations where id = $1', [conversationId]);
  return res.rows[0]?.blocked_at != null;
}

// Marks a conversation as automatically talking to another bot on the other
// side (a WhatsApp Business auto-reply, a menu tree, a broadcast system).
// Reuses blocked_at so isConversationBlocked already stops replies - no new
// column needed. The handoff_reason prefix "peer_bot:" lets the console
// render a small robot chip and lets us tell "we blocked them" apart from
// "we detected the peer is automated". Silent by design - no notification,
// no push, no toast; the team does not need to be pinged about every
// automated peer that sprays messages at the number.
export async function markConversationAsPeerBot(pool, conversationId, reason) {
  const detail = (reason || '').toString().trim().slice(0, 200);
  await pool.query(
    `update conversations
       set blocked_at = coalesce(blocked_at, now()),
           handoff_reason = $2,
           updated_at = now()
     where id = $1`,
    [conversationId, `peer_bot: ${detail || 'other side appears automated'}`],
  );
}

// Cheap defensive count for the runaway-loop safety net: how many outbound
// messages have we sent in this conversation in the last N minutes, and does
// the contact have any identifying details captured. If we have sent a lot
// and know nothing about who we are talking to, the far side is very likely
// a bot even if the AI itself has not flagged it yet.
// Minimum bar for an AI-initiated handoff. A qualified lead has at least
// their name AND either a business/email/address OR a real requirement/budget/
// timeline in lead_details. Complaint-driven handoffs bypass this check
// upstream - the point of the floor is to stop the AI escalating strangers
// with no context, not to block a genuine issue.
export async function isLeadQualifiedEnough(pool, conversationId) {
  const res = await pool.query(
    `select
       ct.name,
       (ct.business is not null or ct.email is not null or ct.address is not null) as has_org_field,
       ((ct.lead_details ? 'requirement') or (ct.lead_details ? 'budget') or (ct.lead_details ? 'timeline')) as has_intent_field
     from contacts ct
     join conversations c on c.contact_id = ct.id
     where c.id = $1`,
    [conversationId],
  );
  const row = res.rows[0];
  if (!row) return false;
  const hasName = Boolean(row.name && row.name.trim());
  const hasContext = Boolean(row.has_org_field || row.has_intent_field);
  return hasName && hasContext;
}

export async function recentOutboundStats(pool, conversationId, minutes = 15) {
  const res = await pool.query(
    `select
       (select count(*) from messages
         where conversation_id = $1
           and direction = 'outbound'
           and created_at > now() - make_interval(mins => $2))::int as recent_outbound,
       (select (ct.name is not null or ct.business is not null or ct.email is not null or ct.address is not null)
        from contacts ct join conversations c on c.contact_id = ct.id where c.id = $1) as has_lead_info`,
    [conversationId, minutes],
  );
  return {
    recentOutbound: res.rows[0]?.recent_outbound ?? 0,
    hasLeadInfo: Boolean(res.rows[0]?.has_lead_info),
  };
}

// Hard-deletes conversations soft-deleted more than the given days ago, and
// everything hanging off them. Run from the scheduler. handoff_events and
// notifications cascade; messages and drip_jobs do not, so clear them first.
export async function purgeDeletedConversations(pool, olderThanDays = 30) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const ids = (await client.query(
      `select id from conversations
       where deleted_at is not null and deleted_at < now() - ($1 || ' days')::interval`,
      [String(olderThanDays)],
    )).rows.map((r) => r.id);
    if (ids.length === 0) { await client.query('commit'); return 0; }
    await client.query('delete from messages where conversation_id = any($1)', [ids]);
    await client.query('delete from drip_jobs where conversation_id = any($1)', [ids]);
    await client.query('delete from conversations where id = any($1)', [ids]);
    await client.query('commit');
    return ids.length;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Lets an agent correct or fill in what we know about a lead from the chat's
// side panel. wa_id is deliberately not editable here - it is the identity
// key everything else (messages, drips, the export) hangs off, so changing it
// belongs to reconcileContactWaId's careful merge-avoidance logic, not a
// free-text edit.
export async function updateContactDetails(pool, conversationId, { name, email, business, address } = {}) {
  const res = await pool.query(
    `update contacts set
       name = coalesce($2, name),
       email = coalesce($3, email),
       business = coalesce($4, business),
       address = coalesce($5, address),
       last_seen_at = now()
     where id = (select contact_id from conversations where id = $1)
     returning name, email, business, address`,
    [conversationId, name, email, business, address],
  );
  return res.rows[0] ?? null;
}

// Meta's Cloud API can normalise the number we dial to a different wa_id for
// a handful of countries (a leading trunk/national digit gets stripped or
// added) - that normalised id is what shows up as "from" on every message
// this lead sends back. Left unreconciled, a number we message first (via
// Compose or a bulk send) and that same lead's later reply end up as two
// separate contacts and conversations. This is safe to call after every send:
// a no-op when the id already matches, and a no-op (not an error) rather than
// a unique-constraint crash on the rare chance the canonical id already
// belongs to a different contact - that case needs a human to merge them by
// hand, not an automatic rewrite that could attach one lead's history to
// another's.
export async function reconcileContactWaId(pool, conversationId, canonicalWaId) {
  if (!canonicalWaId) return;
  await pool.query(
    `update contacts set wa_id = $2, last_seen_at = now()
     where id = (select contact_id from conversations where id = $1)
       and wa_id <> $2
       and not exists (select 1 from contacts other where other.wa_id = $2)`,
    [conversationId, canonicalWaId],
  );
}

export async function getConversationById(pool, id) {
  await pool.query('update conversations set last_read_at = now() where id = $1', [id]);
  const res = await pool.query(
    `select c.id, c.state, c.assignee, c.window_expires_at, c.handoff_reason, c.suggested_agent,
            c.pinned_at, c.archived_at, c.muted_until, c.blocked_at, c.deleted_at,
            c.campaign_id, ct.wa_id, ct.name, ct.email, ct.business, ct.address, ct.lead_details,
            ct.opted_out_at,
            coalesce(ca.topic_id, c.last_topic_id) as topic_id,
            t.name as topic_name,
            coalesce((
              select json_agg(json_build_object('id', tg.id, 'name', tg.name, 'color', tg.color) order by tg.name)
              from conversation_tags ctg join tags tg on tg.id = ctg.tag_id
              where ctg.conversation_id = c.id
            ), '[]') as tags
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join campaigns ca on ca.id = c.campaign_id
     left join topics t on t.id = coalesce(ca.topic_id, c.last_topic_id)
     where c.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

// Returns a page of messages newest-first from the database, reversed to
// ascending for display, plus whether older messages remain. Keyset paginated
// on the display sort key (sent_at, id) so a late-arriving message can't cause
// a page to skip or repeat a row. Pass beforeId (the oldest message already
// loaded) to fetch the previous page.
export async function getConversationMessages(pool, id, { limit = 50, beforeId = null } = {}) {
  const res = await pool.query(
    `select id, wa_message_id, direction, type, body, status, created_at,
            coalesce(sent_at, created_at) as sent_at,
            raw->'context'->>'id' as reply_to_wamid,
            raw->'reaction'->>'message_id' as reacted_to_wamid,
            raw->'reaction'->>'emoji' as reaction_emoji,
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
     from messages
     where conversation_id = $1
       and created_at > coalesce((select cleared_at from conversations where id = $1), '1970-01-01')
       and ($2::bigint is null or
            (coalesce(sent_at, created_at), id) <
            (select coalesce(sent_at, created_at), id from messages where id = $2))
     order by coalesce(sent_at, created_at) desc, id desc
     limit $3`,
    [id, beforeId, limit],
  );
  const hasMore = res.rows.length === limit;
  // Reverse to ascending (oldest first) for the thread view.
  return { messages: res.rows.reverse(), hasMore };
}

export async function listTemplates(pool) {
  const res = await pool.query(
    "select name, language, category, body, status, header_type from templates where active = true and (status is null or status = 'APPROVED') order by name",
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
        `insert into templates (name, language, category, body, status, header_type, active)
         values ($1, $2, $3, $4, $5, $6, true)
         on conflict (name) do update set
           language = excluded.language,
           category = excluded.category,
           body = excluded.body,
           status = excluded.status,
           header_type = excluded.header_type,
           active = true`,
        [t.name, t.language ?? 'en', t.category ?? null, t.body ?? null, t.status ?? null, t.headerType ?? null],
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
  return (await pool.query('select id, email, name, role, created_at from agents order by id')).rows;
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

// Internal, agent-only notes on a conversation - never sent to the lead.
export async function addConversationNote(pool, conversationId, agentEmail, note) {
  const r = await pool.query(
    'insert into conversation_notes (conversation_id, agent_email, note) values ($1, $2, $3) returning id, agent_email, note, created_at',
    [conversationId, agentEmail, note],
  );
  return r.rows[0];
}

export async function listConversationNotes(pool, conversationId) {
  return (
    await pool.query(
      'select id, agent_email, note, created_at from conversation_notes where conversation_id = $1 order by created_at desc',
      [conversationId],
    )
  ).rows;
}

export async function deleteConversationNote(pool, id, agentEmail, isAdmin) {
  const res = isAdmin
    ? await pool.query('delete from conversation_notes where id = $1', [id])
    : await pool.query('delete from conversation_notes where id = $1 and agent_email = $2', [id, agentEmail]);
  return res.rowCount > 0;
}

// Freeform tags (won, lost, spam, follow-up-later, ...) any agent can put on
// a conversation. The tag list itself is shared/reused by name so the same
// label always means the same thing across every conversation it's on.
export async function listTags(pool) {
  return (await pool.query('select id, name, color from tags order by name')).rows;
}

export async function getOrCreateTag(pool, name, color) {
  const trimmed = name.trim();
  const existing = await pool.query('select id, name, color from tags where lower(name) = lower($1)', [trimmed]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await pool.query(
    'insert into tags (name, color) values ($1, $2) returning id, name, color',
    [trimmed, color || '#6b7280'],
  );
  return created.rows[0];
}

export async function deleteTag(pool, id) {
  await pool.query('delete from tags where id = $1', [id]);
}

export async function tagConversation(pool, conversationId, tagId) {
  await pool.query(
    'insert into conversation_tags (conversation_id, tag_id) values ($1, $2) on conflict do nothing',
    [conversationId, tagId],
  );
}

export async function untagConversation(pool, conversationId, tagId) {
  await pool.query('delete from conversation_tags where conversation_id = $1 and tag_id = $2', [conversationId, tagId]);
}

export async function listConversationTags(pool, conversationId) {
  return (
    await pool.query(
      `select t.id, t.name, t.color from conversation_tags ct
       join tags t on t.id = ct.tag_id
       where ct.conversation_id = $1
       order by t.name`,
      [conversationId],
    )
  ).rows;
}

// A fairness hint for a pending handoff: cycles through every agent in id
// order using a cursor stored in settings, so "whose turn is it" rotates
// evenly instead of the same fast-clicking agent always grabbing the queue.
// Purely a suggestion - the pending queue itself still lets anyone accept.
export async function pickNextAgentRoundRobin(pool) {
  const agents = (await pool.query('select id, email from agents order by id')).rows;
  if (agents.length === 0) return null;

  const cursor = await pool.query("select value from settings where key = 'last_suggested_agent_id'");
  const lastId = cursor.rows[0]?.value ?? null;
  // agents.id is bigserial - node-pg returns bigint columns as strings, so
  // this must compare as strings too or it always misses (lastIndex stuck at
  // -1, "next" always the first agent).
  const lastIndex = lastId != null ? agents.findIndex((a) => String(a.id) === String(lastId)) : -1;
  const next = agents[(lastIndex + 1) % agents.length];

  await pool.query(
    `insert into settings (key, value, updated_at) values ('last_suggested_agent_id', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [String(next.id)],
  );
  return next.email;
}

export async function metrics(pool) {
  const r = await pool.query(
    `select
       (select count(*) from contacts where name is not null and dismissed_as_lead_at is null) as leads,
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
  // "Leads" only counts a contact once something is actually known about
  // them (at minimum a name) - a raw wa_id nobody ever got a name for is not
  // something the client can act on, so it should not inflate the count they
  // see on the dashboard either.
  const r = await pool.query(
    `select
       (select count(*) from contacts where name is not null and dismissed_as_lead_at is null) as leads,
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
     where first_seen_at >= now() - interval '30 days' and name is not null and dismissed_as_lead_at is null
     group by date
     order by date asc`
  );

  return {
    ...r.rows[0],
    leads_per_day: leadsHistory.rows,
  };
}

// The full detail behind the dashboard's "Total leads" number - every field
// saved so far for a contact with at least a name on file, plus their most
// recent conversation state. This must stay consistent with overview()'s
// leads count and criteria (name is not null, not dismissed), or the two
// numbers on the dashboard would silently disagree. Filters mirror what the
// dashboard lets you narrow down by, and listContactsForExport below reuses
// the exact same clauses so the download always matches what's on screen.
function leadFilterClauses({ topicId = null, state = null, search = null } = {}) {
  const clauses = ['ct.name is not null', 'ct.dismissed_as_lead_at is null'];
  const params = [];
  if (topicId != null) {
    params.push(topicId);
    clauses.push(`coalesce(ca.topic_id, c.last_topic_id) = $${params.length}`);
  }
  if (state) {
    params.push(state);
    clauses.push(`c.state = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(ct.name ilike $${params.length} or ct.wa_id ilike $${params.length} or ct.business ilike $${params.length})`);
  }
  return { where: clauses.join(' and '), params };
}

export async function listLeads(pool, filters = {}) {
  const { where, params } = leadFilterClauses(filters);
  const res = await pool.query(
    `select ct.id as contact_id, c.id as conversation_id,
            ct.wa_id, ct.name, ct.email, ct.business, ct.address, ct.lead_details,
            c.state, t.name as topic_name
     from contacts ct
     left join conversations c on c.contact_id = ct.id
     left join campaigns ca on ca.id = c.campaign_id
     left join topics t on t.id = coalesce(ca.topic_id, c.last_topic_id)
     where ${where}
     order by ct.first_seen_at desc
     limit 2000`,
    params,
  );
  return res.rows;
}

// Removes a contact from the leads list/count/export without touching their
// conversation or messages - for ad noise and wrong numbers that picked up a
// name but were never really a lead. Reversible only by hand in the database
// for now, on purpose: this is meant for "get this off my leads list", not a
// frequent action that needs its own undo UI.
export async function dismissLead(pool, contactId) {
  await pool.query('update contacts set dismissed_as_lead_at = now() where id = $1', [contactId]);
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

// topicId: a real id filters to that service, 'general' filters to files
// with no topic (the ones any lead can be sent), omitted/null returns everything.
export async function listMediaAssets(pool, { topicId = null } = {}) {
  if (topicId === 'general') {
    return (
      await pool.query(
        `select id, meta_media_id, filename, mime_type, kind, caption, topic_id, description, created_at
         from media_assets where topic_id is null order by id desc limit 100`,
      )
    ).rows;
  }
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

// Files the AI can choose to attach for this reply: whatever belongs to the
// services in play, plus anything with no service at all. A file with no
// description is skipped since the model has nothing to judge relevance from.
export async function getMediaCatalog(pool, topicIds = []) {
  const ids = topicIds.map(Number).filter((n) => Number.isFinite(n));
  const res = await pool.query(
    `select id, filename, description, kind, topic_id
     from media_assets
     where description is not null and description <> ''
       and (topic_id is null or topic_id = any($1::bigint[]))
     order by topic_id nulls last, id desc
     limit 300`,
    [ids],
  );
  return res.rows;
}

// What has already gone out in this conversation, most recent first, so the
// model can be told rather than guessing whether something was just sent.
export async function getRecentMediaSends(pool, conversationId, limit = 5) {
  const res = await pool.query(
    `select m.media_asset_id, ma.filename, m.created_at
     from messages m
     join media_assets ma on ma.id = m.media_asset_id
     where m.conversation_id = $1 and m.direction = 'outbound' and m.media_asset_id is not null
     order by m.created_at desc
     limit $2`,
    [conversationId, limit],
  );
  return res.rows;
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

// raw only ever holds a lead's own inbound webhook payload - a file the bot
// sent from the media library has no raw at all, its media lives in
// media_assets instead. Joined in here so the download route has one place
// to look regardless of which direction the file came from.
export async function getMessageRaw(pool, id) {
  return (
    await pool.query(
      `select m.id, m.type, m.raw, ma.meta_media_id as asset_meta_media_id
       from messages m
       left join media_assets ma on ma.id = m.media_asset_id
       where m.id = $1`,
      [id],
    )
  ).rows[0] ?? null;
}

export async function getMediaAsset(pool, id) {
  return (
    await pool.query('select id, meta_media_id, filename, mime_type, kind, caption from media_assets where id = $1', [id])
  ).rows[0] ?? null;
}

// Payment links, one per topic per purpose (e.g. an analysis fee and a
// project deposit for the same service). Same shape and guardrails as media
// assets: admin manages the list, the AI is shown a catalog and picks one by
// id, never allowed to invent a url.
export async function addPaymentLink(pool, p) {
  const r = await pool.query(
    `insert into payment_links (topic_id, label, amount_inr, url, description)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [p.topicId ?? null, p.label, p.amountInr ?? null, p.url, p.description ?? null],
  );
  return r.rows[0].id;
}

export async function updatePaymentLink(pool, id, p) {
  await pool.query(
    `update payment_links set
       topic_id = $2, label = $3, amount_inr = $4, url = $5, description = $6, active = $7, updated_at = now()
     where id = $1`,
    [id, p.topicId ?? null, p.label, p.amountInr ?? null, p.url, p.description ?? null, p.active !== false],
  );
}

export async function deletePaymentLink(pool, id) {
  await pool.query('delete from payment_links where id = $1', [id]);
}

// topicId: a real id filters to that service, omitted/null returns everything
// (including links with no topic, which apply to any conversation).
export async function listPaymentLinks(pool, { topicId = null } = {}) {
  if (topicId) {
    return (
      await pool.query(
        `select id, topic_id, label, amount_inr, url, description, active, created_at
         from payment_links where topic_id = $1 order by id desc`,
        [topicId],
      )
    ).rows;
  }
  return (
    await pool.query(
      `select id, topic_id, label, amount_inr, url, description, active, created_at
       from payment_links order by topic_id nulls last, id desc`,
    )
  ).rows;
}

// Links the AI can choose to send for this reply: whatever belongs to the
// services in play, plus anything with no service at all (general links).
export async function getPaymentLinkCatalog(pool, topicIds = []) {
  const ids = topicIds.map(Number).filter((n) => Number.isFinite(n));
  const res = await pool.query(
    `select id, label, amount_inr, url, description, topic_id
     from payment_links
     where active = true
       and (topic_id is null or topic_id = any($1::bigint[]))
     order by topic_id nulls last, id desc
     limit 50`,
    [ids],
  );
  return res.rows;
}

export async function getPaymentLink(pool, id) {
  return (
    await pool.query('select id, label, amount_inr, url from payment_links where id = $1', [id])
  ).rows[0] ?? null;
}

// Hosted links: an admin-curated catalog of external URLs (Drive/S3/YouTube/
// portfolio pages) the AI can share when a customer asks for something too
// large for WhatsApp's 100 MB media cap, or too dynamic to upload as a file
// (a rolling case-study page, a live gallery). Same picker shape as payment
// links: model is shown the catalog, picks one by id, never invents a URL.
export async function addHostedLink(pool, p) {
  const r = await pool.query(
    `insert into hosted_links (topic_id, label, url, description)
     values ($1, $2, $3, $4)
     returning id`,
    [p.topicId ?? null, p.label, p.url, p.description ?? null],
  );
  return r.rows[0].id;
}

export async function updateHostedLink(pool, id, p) {
  await pool.query(
    `update hosted_links set
       topic_id = $2, label = $3, url = $4, description = $5, active = $6, updated_at = now()
     where id = $1`,
    [id, p.topicId ?? null, p.label, p.url, p.description ?? null, p.active !== false],
  );
}

export async function deleteHostedLink(pool, id) {
  await pool.query('delete from hosted_links where id = $1', [id]);
}

export async function listHostedLinks(pool, { topicId = null } = {}) {
  if (topicId) {
    return (
      await pool.query(
        `select id, topic_id, label, url, description, active, created_at
         from hosted_links where topic_id = $1 order by id desc`,
        [topicId],
      )
    ).rows;
  }
  return (
    await pool.query(
      `select id, topic_id, label, url, description, active, created_at
       from hosted_links order by topic_id nulls last, id desc`,
    )
  ).rows;
}

export async function getHostedLinkCatalog(pool, topicIds = []) {
  const ids = topicIds.map(Number).filter((n) => Number.isFinite(n));
  const res = await pool.query(
    `select id, label, url, description, topic_id
     from hosted_links
     where active = true
       and (topic_id is null or topic_id = any($1::bigint[]))
     order by topic_id nulls last, id desc
     limit 50`,
    [ids],
  );
  return res.rows;
}

export async function getHostedLink(pool, id) {
  return (
    await pool.query('select id, label, url from hosted_links where id = $1', [id])
  ).rows[0] ?? null;
}

// Records a factual, extraction-only note about an inbound image/PDF against
// that exact message, so a human reading the thread and the AI's next turn
// both have it without re-opening the file.
export async function saveAttachmentContext(pool, messageId, note) {
  if (!messageId || !note) return;
  await pool.query('update messages set attachment_context = $2 where id = $1', [messageId, note]);
}

// How many images/documents this lead has sent in the last N minutes - the
// throttle that keeps someone from running up the vision API bill by
// spamming files. Counts inbound image/document messages regardless of
// whether they were actually analysed (a skipped one still counts, so the
// window can't be dodged by sending faster than the analysis takes).
export async function countRecentAttachments(pool, conversationId, minutes) {
  const res = await pool.query(
    `select count(*)::int as n from messages
     where conversation_id = $1 and direction = 'inbound' and type in ('image', 'document')
       and created_at > now() - make_interval(mins => $2)`,
    [conversationId, minutes],
  );
  return res.rows[0]?.n ?? 0;
}

// Ops panel stats: DB-side counters for the admin health panel.
export async function opsStats(pool) {
  const r = await pool.query(
    `select
       (select count(*) from conversations where state = 'pending') as pending_chats,
       (select count(*) from conversations where state = 'bot')     as bot_chats,
       (select count(*) from conversations where state = 'human')   as human_chats,
       (select count(*) from webhook_dead_letter where resolved_at is null) as dead_letter_depth,
       (select round(avg(ai_ms)) from messages where ai_ms is not null and created_at > now() - interval '1 hour') as ai_ms_p50_1h,
       (select round(avg(meta_ms)) from messages where meta_ms is not null and created_at > now() - interval '1 hour') as meta_ms_p50_1h,
       (select count(*) from handoff_events where created_at > now() - interval '24 hours') as handoffs_24h,
       (select count(*) from messages where direction = 'outbound' and created_at > now() - interval '24 hours') as replies_24h`,
  );
  const handoffBreakdown = await pool.query(
    `select reason_category, count(*)::int as count
     from handoff_events
     where created_at > now() - interval '7 days'
       and reason_category is not null
     group by reason_category
     order by count desc`,
  );

  // First response time: how long from a lead's first message to the first
  // reply they got (bot or human, whichever answered first). Time to
  // qualification: how long from a conversation starting to the first time
  // it was actually handed off - the number the whole qualification-gated
  // handoff redesign is meant to move. Both restricted to the last 30 days
  // so a stat from months ago doesn't drag on what "normal" looks like now.
  const funnel = await pool.query(
    `with first_inbound as (
       select conversation_id, min(coalesce(sent_at, created_at)) as t
       from messages where direction = 'inbound'
       group by conversation_id
     ),
     first_outbound as (
       select conversation_id, min(coalesce(sent_at, created_at)) as t
       from messages where direction = 'outbound'
       group by conversation_id
     ),
     first_handoff as (
       select conversation_id, min(created_at) as t
       from handoff_events
       group by conversation_id
     )
     select
       (select round(avg(extract(epoch from (fo.t - fi.t))))
        from first_inbound fi join first_outbound fo using (conversation_id)
        where fo.t > fi.t and fi.t > now() - interval '30 days') as avg_first_response_seconds,
       (select round(avg(extract(epoch from (fh.t - c.created_at))))
        from first_handoff fh join conversations c on c.id = fh.conversation_id
        where fh.t > now() - interval '30 days') as avg_time_to_qualification_seconds,
       (select count(*) from first_handoff fh join conversations c on c.id = fh.conversation_id
        where fh.t > now() - interval '30 days') as qualified_30d`,
  );

  // Hourly message/handoff volume for the last 24h, zero-filled so the chart
  // has no gaps for quiet hours - a real trend line, not just a snapshot.
  const activity = await pool.query(
    `with hours as (
       select generate_series(
         date_trunc('hour', now() - interval '23 hours'),
         date_trunc('hour', now()),
         interval '1 hour'
       ) as hour
     )
     select
       to_char(h.hour, 'HH24:00') as hour,
       coalesce(m_in.c, 0)::int as inbound,
       coalesce(m_out.c, 0)::int as outbound,
       coalesce(ho.c, 0)::int as handoffs
     from hours h
     left join (
       select date_trunc('hour', created_at) as hour, count(*) as c
       from messages where direction = 'inbound' and created_at > now() - interval '24 hours'
       group by 1
     ) m_in on m_in.hour = h.hour
     left join (
       select date_trunc('hour', created_at) as hour, count(*) as c
       from messages where direction = 'outbound' and created_at > now() - interval '24 hours'
       group by 1
     ) m_out on m_out.hour = h.hour
     left join (
       select date_trunc('hour', created_at) as hour, count(*) as c
       from handoff_events where created_at > now() - interval '24 hours'
       group by 1
     ) ho on ho.hour = h.hour
     order by h.hour asc`,
  );

  // Runaway threads: contacts we've sent an unusual number of bot replies to
  // in the last hour. A real long conversation with an interested lead is
  // fine; this specifically flags cases where the bot may be looping with
  // another automated system without being noticed yet (peer-bot detection
  // silences the pings for these, so an at-a-glance panel is what surfaces
  // them). Capped at 20 rows so the widget stays lightweight.
  const runaway = await pool.query(
    `select c.id as conversation_id,
            ct.wa_id,
            ct.name,
            count(m.id)::int as reply_count,
            (c.blocked_at is not null and c.handoff_reason like 'peer_bot:%') as marked_bot
     from messages m
     join conversations c on c.id = m.conversation_id
     join contacts ct on ct.id = c.contact_id
     where m.direction = 'outbound'
       and m.created_at > now() - interval '1 hour'
     group by c.id, ct.wa_id, ct.name, c.blocked_at, c.handoff_reason
     having count(m.id) >= 5
     order by count(m.id) desc
     limit 20`,
  );

  return {
    ...r.rows[0],
    ...funnel.rows[0],
    handoff_breakdown: handoffBreakdown.rows,
    activity_hourly: activity.rows,
    runaway_threads: runaway.rows,
  };
}

// Stalled chats to hand back to the bot: either an agent has gone quiet on a
// chat they own, or nobody accepted a pending handoff in time. Either way the
// lead should not be left waiting indefinitely.
export async function conversationsToResume(pool, minutes) {
  const res = await pool.query(
    `select c.id, ct.wa_id, ca.topic_id,
       (select m.wa_message_id from messages m
        where m.conversation_id = c.id
        order by m.created_at desc, m.id desc
        limit 1) as last_inbound_wamid
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

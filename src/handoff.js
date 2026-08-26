// Bot to a human is a two step handoff now. The bot (or a lead asking for a
// person) moves a conversation to pending with a short reason, then an agent
// either accepts it (claims it, becomes the assignee) or rejects it (sends it
// straight back to the bot). This replaces jumping straight to "with a
// human", which used to leave chats nobody had actually picked up looking
// the same as ones an agent was actively working.

// Bot or lead initiated. Queues the conversation for an agent to pick up.
export async function handToPending(pool, conversationId, reason = null) {
  await pool.query(
    "update conversations set state = 'pending', assignee = null, handoff_reason = $2, assigned_at = now(), updated_at = now() where id = $1",
    [conversationId, reason],
  );
}

// An agent accepts a pending handoff, or proactively takes over a bot owned
// chat. Either way they are now the owner.
export async function handToHuman(pool, conversationId, assignee = null) {
  await pool.query(
    "update conversations set state = 'human', assignee = $2, assigned_at = now(), updated_at = now() where id = $1",
    [conversationId, assignee],
  );
}

// Human back to bot. Used when an agent gives back a chat they were handling,
// when an agent rejects a pending handoff, and by the auto resume.
export async function handToBot(pool, conversationId) {
  await pool.query(
    "update conversations set state = 'bot', assignee = null, handoff_reason = null, updated_at = now() where id = $1",
    [conversationId],
  );
}

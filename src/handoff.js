import { pickNextAgentRoundRobin } from './db/repo.js';

// Bot to a human is a two step handoff now. The bot (or a lead asking for a
// person) moves a conversation to pending with a short reason, then an agent
// either accepts it or rejects it - either way they become the owner, since
// rejecting means "the AI shouldn't have flagged this, I'll deal with it
// myself" rather than "send it back to the bot" or "leave it untouched".
// This replaces jumping straight to "with a human", which used to leave
// chats nobody had actually picked up looking the same as ones an agent was
// actively working.

// Bot or lead initiated. Queues the conversation for an agent to pick up.
// suggested_agent is a fairness hint (see pickNextAgentRoundRobin) - it never
// blocks anyone else from accepting, it just rotates whose turn it is.
export async function handToPending(pool, conversationId, reason = null) {
  const suggestedAgent = await pickNextAgentRoundRobin(pool).catch(() => null);
  await pool.query(
    "update conversations set state = 'pending', assignee = null, handoff_reason = $2, suggested_agent = $3, assigned_at = now(), updated_at = now() where id = $1",
    [conversationId, reason, suggestedAgent],
  );
}

// An agent accepts a pending handoff, or proactively takes over a bot owned
// chat. Either way they are now the owner.
export async function handToHuman(pool, conversationId, assignee = null) {
  await pool.query(
    "update conversations set state = 'human', assignee = $2, suggested_agent = null, assigned_at = now(), updated_at = now() where id = $1",
    [conversationId, assignee],
  );
}

// Human back to bot. Used when an agent gives back a chat they were handling
// and by the auto resume.
export async function handToBot(pool, conversationId) {
  await pool.query(
    "update conversations set state = 'bot', assignee = null, handoff_reason = null, suggested_agent = null, updated_at = now() where id = $1",
    [conversationId],
  );
}

// Bot to human. Records when the takeover happened so the auto resume can tell
// how long a human has been sitting on the chat. The bot stays quiet on a
// conversation while its state is human.
export async function handToHuman(pool, conversationId, assignee = null) {
  await pool.query(
    "update conversations set state = 'human', assignee = $2, assigned_at = now(), updated_at = now() where id = $1",
    [conversationId, assignee],
  );
}

// Human back to bot. Used by an agent from the console, and by the auto resume.
export async function handToBot(pool, conversationId) {
  await pool.query(
    "update conversations set state = 'bot', assignee = null, updated_at = now() where id = $1",
    [conversationId],
  );
}

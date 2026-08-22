import { setConversationState } from './db/repo.js';

// Bot to human. The bot stays quiet on a conversation while its state is human.
export async function handToHuman(pool, conversationId, assignee = null) {
  await setConversationState(pool, conversationId, 'human', assignee);
}

// Human back to bot. Used by an agent from the console to let the bot resume.
export async function handToBot(pool, conversationId) {
  await setConversationState(pool, conversationId, 'bot', null);
}

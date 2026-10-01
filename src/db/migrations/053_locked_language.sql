-- Explicit language lock on a conversation. Nullable: when NULL the AI
-- picks a language per turn (match the customer's most recent message).
-- When set, the prompt instructs the AI to use that language regardless
-- of what the customer writes. Only set when the customer explicitly asks
-- to switch ("reply in English", "Hindi me baat karo", "Gujarati please").
alter table conversations
  add column if not exists locked_language text;

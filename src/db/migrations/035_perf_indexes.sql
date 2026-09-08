-- conversations.campaign_id is joined/filtered by campaignStats and other
-- campaign-scoped queries with no index backing it, forcing a sequential
-- scan over conversations as the table grows.
create index if not exists idx_conversations_campaign on conversations (campaign_id);

-- listConversations' per-conversation "last message" lateral join orders by
-- this exact expression - without a matching index it has to sort every
-- message in a conversation to find the top one, for every conversation in
-- the list, on every load of the console's main screen.
create index if not exists idx_messages_conv_last on messages (conversation_id, (coalesce(sent_at, created_at)) desc, id desc);

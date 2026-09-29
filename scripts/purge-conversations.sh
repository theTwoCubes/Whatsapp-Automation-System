#!/usr/bin/env bash
# Wipes every lead/chat/conversation trace from the database.
# Keeps: knowledge (topics, faqs, faq_versions), media library, payment links,
# hosted links, agents, settings, templates, brand, tags catalog, campaigns,
# audit log.
# Deletes: conversations, messages, contacts, drip jobs, handoff events,
# notifications, dead-letter, faq proposals, notes, conversation tags,
# bulk-send jobs. Resets learning cursors.
#
# Run from the project root. Takes a full backup first via backup.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

user="${POSTGRES_USER:-whatsapp}"
db="${POSTGRES_DB:-whatsapp}"
host="${POSTGRES_HOST:-localhost}"
port="${POSTGRES_PORT:-5432}"

if docker compose -f docker-compose.prod.yml ps --quiet db 2>/dev/null | grep -q .; then
  runner=(docker compose -f docker-compose.prod.yml exec -T db psql -U "$user" -d "$db" -v ON_ERROR_STOP=1)
else
  export PGPASSWORD="${POSTGRES_PASSWORD:-}"
  runner=(psql -h "$host" -p "$port" -U "$user" -d "$db" -v ON_ERROR_STOP=1)
fi

echo "Current row counts (before):"
"${runner[@]}" -c "
  select 'conversations' as t, count(*) from conversations
  union all select 'messages',          count(*) from messages
  union all select 'contacts',          count(*) from contacts
  union all select 'drip_jobs',         count(*) from drip_jobs
  union all select 'handoff_events',    count(*) from handoff_events
  union all select 'notifications',     count(*) from notifications
  union all select 'webhook_dead_letter', count(*) from webhook_dead_letter
  union all select 'faq_proposals',     count(*) from faq_proposals
  union all select 'conversation_notes', count(*) from conversation_notes
  union all select 'conversation_tags', count(*) from conversation_tags
  union all select 'bulk_send_jobs',    count(*) from bulk_send_jobs
  order by 1;
"

echo
echo "This will permanently delete every conversation, message, lead, drip,"
echo "handoff, notification, note, tag assignment, and dead-letter row."
echo "Knowledge, media, payment links, hosted links, agents, settings, and the audit log"
echo "will be kept intact."
echo
read -r -p 'Type PURGE to proceed: ' confirm
if [ "$confirm" != "PURGE" ]; then
  echo "Aborted."
  exit 1
fi

echo
echo "Taking a fresh backup first..."
bash scripts/backup.sh
echo

"${runner[@]}" <<'SQL'
begin;
truncate
  conversation_tags,
  conversation_notes,
  faq_proposals,
  notifications,
  webhook_dead_letter,
  handoff_events,
  drip_jobs,
  bulk_send_jobs,
  messages,
  conversations,
  contacts
restart identity cascade;

update learning_state
  set last_message_id = 0,
      last_handoff_id = 0,
      last_run_at = null
  where id = 1;
commit;
SQL

echo
echo "Row counts (after):"
"${runner[@]}" -c "
  select 'conversations' as t, count(*) from conversations
  union all select 'messages',          count(*) from messages
  union all select 'contacts',          count(*) from contacts
  union all select 'drip_jobs',         count(*) from drip_jobs
  union all select 'handoff_events',    count(*) from handoff_events
  union all select 'notifications',     count(*) from notifications
  union all select 'webhook_dead_letter', count(*) from webhook_dead_letter
  union all select 'faq_proposals',     count(*) from faq_proposals
  union all select 'conversation_notes', count(*) from conversation_notes
  union all select 'conversation_tags', count(*) from conversation_tags
  union all select 'bulk_send_jobs',    count(*) from bulk_send_jobs
  order by 1;
"

echo
echo "Done. Backup is in backups/ if you need to roll this back."

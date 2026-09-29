#!/usr/bin/env bash
# Wipes the audit log table only. Everything else is untouched.
# Backs up the database first so a mistake is recoverable.
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

echo "Current audit log:"
"${runner[@]}" -c "select count(*) as rows, min(created_at) as oldest, max(created_at) as newest from audit_log;"

echo
echo "This will permanently delete every row from audit_log."
echo "Nothing else is touched."
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

"${runner[@]}" -c "truncate audit_log restart identity;"

echo
"${runner[@]}" -c "select count(*) as rows_after from audit_log;"
echo "Done. Backup is in backups/ if you need to roll this back."

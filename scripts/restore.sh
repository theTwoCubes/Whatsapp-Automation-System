#!/usr/bin/env bash
# Restores a backup made by backup.sh. Defaults to restoring into a throwaway
# database (never the live one) so running this to check a backup is actually
# good never risks the real data - that's the point of a restore drill.
# Usage: bash scripts/restore.sh backups/whatsapp-20260101-020000.sql.gz [target_db]
set -euo pipefail

cd "$(dirname "$0")/.."

file="${1:-}"
if [ -z "$file" ]; then
  echo "usage: bash scripts/restore.sh <path-to-backup.sql.gz> [target_db]" >&2
  exit 1
fi
if [ ! -f "$file" ]; then
  echo "no such file: $file" >&2
  exit 1
fi

user="${POSTGRES_USER:-whatsapp}"
host="${POSTGRES_HOST:-localhost}"
port="${POSTGRES_PORT:-5432}"
target="${2:-${POSTGRES_DB:-whatsapp}_restore_check}"

echo "restoring $file into database '$target' (leaves '${POSTGRES_DB:-whatsapp}' untouched)"

if docker compose -f docker-compose.prod.yml ps --quiet db 2>/dev/null | grep -q .; then
  docker compose -f docker-compose.prod.yml exec -T db \
    psql -U "$user" -d postgres -c "drop database if exists ${target};" >/dev/null
  docker compose -f docker-compose.prod.yml exec -T db \
    psql -U "$user" -d postgres -c "create database ${target};" >/dev/null
  gunzip -c "$file" | docker compose -f docker-compose.prod.yml exec -T db \
    psql -U "$user" -d "$target" >/dev/null
else
  PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h "$host" -p "$port" -U "$user" -d postgres \
    -c "drop database if exists ${target};" >/dev/null
  PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h "$host" -p "$port" -U "$user" -d postgres \
    -c "create database ${target};" >/dev/null
  gunzip -c "$file" | PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h "$host" -p "$port" -U "$user" -d "$target" >/dev/null
fi

echo "restored into '$target'. Spot check it, then drop it when done:"
echo "  psql -U $user -h $host -p $port -d postgres -c 'drop database ${target};'"

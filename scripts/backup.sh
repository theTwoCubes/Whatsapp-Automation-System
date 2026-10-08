#!/usr/bin/env bash
# Dumps the database to backups/ and keeps the 14 most recent files.
# Run from the project root, or from cron. See the Backups section in DEPLOY.md
# for the cron entry and for how to actually restore one.
set -euo pipefail

cd "$(dirname "$0")/.."
dir="backups"
mkdir -p "$dir"

user="${POSTGRES_USER:-whatsapp}"
db="${POSTGRES_DB:-whatsapp}"
host="${POSTGRES_HOST:-localhost}"
port="${POSTGRES_PORT:-5432}"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$dir/${db}-${stamp}.sql.gz"

# Prefer docker compose if running containerised, fall back to a direct pg_dump.
if docker compose -f docker-compose.prod.yml ps --quiet db 2>/dev/null | grep -q .; then
  docker compose -f docker-compose.prod.yml exec -T db \
    pg_dump -U "$user" "$db" | gzip > "$out"
else
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
    -h "$host" -p "$port" -U "$user" "$db" | gzip > "$out"
fi

ls -1t "$dir"/*.sql.gz | tail -n +15 | xargs -r rm -f
echo "backup written to $out ($(du -sh "$out" | cut -f1))"

# Optional: sync to off-box storage. Uncomment and configure rclone or similar.
# rclone copy "$out" r2:advoice-backups/db/ --quiet && echo "synced to remote"

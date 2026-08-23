#!/usr/bin/env bash
# Dumps the database to backups/ and keeps the 14 most recent files.
# Run from the project root, or from cron. See DEPLOY.md.
set -euo pipefail

cd "$(dirname "$0")/.."
dir="backups"
mkdir -p "$dir"

user="${POSTGRES_USER:-whatsapp}"
db="${POSTGRES_DB:-whatsapp}"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$dir/${db}-${stamp}.sql.gz"

docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$user" "$db" | gzip > "$out"

ls -1t "$dir"/*.sql.gz | tail -n +15 | xargs -r rm -f
echo "backup written to $out"

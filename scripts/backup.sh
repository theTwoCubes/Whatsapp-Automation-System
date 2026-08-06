#!/bin/bash
# Nightly Postgres backup with 7-day rotation on local disk.
# Offsite copy is the client's call; add an rclone/rsync line at the end if wanted.
#
# Run from the repo root, or set COMPOSE_DIR. Add to cron, for example:
#   0 2 * * *  cd /opt/whatsapp-agent && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$COMPOSE_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
cd "$COMPOSE_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/all-databases-$STAMP.sql.gz"

# Dump every database in the shared instance in one file.
docker compose exec -T postgres pg_dumpall -U "${POSTGRES_USER:-postgres}" | gzip > "$OUT"

echo "wrote $OUT"

# Rotation: delete dumps older than KEEP_DAYS.
find "$BACKUP_DIR" -name 'all-databases-*.sql.gz' -type f -mtime +"$KEEP_DAYS" -delete

echo "rotation done, kept last $KEEP_DAYS days"

#!/bin/bash
# Runs once on first boot of an empty Postgres data volume.
# Creates the three databases used by the stack. The app schema
# (001) and seed (002) are loaded by the entrypoint into the
# default POSTGRES_USER database, so we point them at the app db.
set -e

createdb_if_missing() {
	local db="$1"
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
		SELECT 'CREATE DATABASE $db'
		WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
	SQL
}

createdb_if_missing "${POSTGRES_APP_DB:-app}"
createdb_if_missing "${POSTGRES_CHATWOOT_DB:-chatwoot}"
createdb_if_missing "${POSTGRES_N8N_DB:-n8n}"

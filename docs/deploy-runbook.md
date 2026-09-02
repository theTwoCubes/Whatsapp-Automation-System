# Deploy runbook

Vendor: theTwoCubes. Client: AdVoice Inc.
VPS: 2 vCPU / 8 GB RAM. OS: Ubuntu 22.04. Proxy: Caddy.

---

## Pre-deploy checklist

- [ ] Take a `pg_dump` backup: `bash scripts/backup.sh`
- [ ] Confirm `.env` is not committed: `git status` must not show it
- [ ] Verify `GEMINI_MODEL` or `OPENAI_MODEL` is a valid live model id
- [ ] Run tests locally: `npm test`
- [ ] Check dead-letter queue is empty (Ops panel → Dead-letter)

---

## Deploy steps

```bash
# 1. Pull the latest code
cd /opt/whatsapp-automation
git pull origin main

# 2. Install any new dependencies
npm ci --omit=dev

# 3. Build the web console
npm run build --prefix web

# 4. Run database migrations (idempotent, safe to re-run)
npm run migrate

# 5. Restart the server (PM2)
pm2 restart wa-console

# 6. Verify
curl -s http://localhost:3001/health
curl -s http://localhost:3001/ready
```

Watch logs for the first 60 seconds after restart:

```bash
pm2 logs wa-console --lines 100
```

---

## Zero-downtime swap (if needed)

Caddy handles TLS and proxies to the Node process. Since Node starts in ~1s and
PM2 does a graceful restart (SIGINT → drain → start new), downtime is negligible.
For a hard requirement use PM2's `--wait-ready` with a `ready` signal from the app.

---

## Rollback

If the new version is broken:

```bash
# 1. Revert to the previous commit
git log --oneline -5
git checkout <prev-sha>

# 2. Reinstall and rebuild
npm ci --omit=dev
npm run build --prefix web

# 3. Restore the DB if the migration was destructive
# (Always confirm the migration is reversible before rolling forward)
pg_restore -U whatsapp -d whatsapp -c backups/whatsapp-YYYYMMDD-HHMMSS.sql.gz

# 4. Restart
pm2 restart wa-console
```

Migrations are additive (add column / add index) and do not need rollback unless
the column itself caused data corruption. Check `docs/production-hardening-plan.md`
Phase 14 for the decision criteria.

---

## Automated backups (cron)

Add to root crontab on the VPS:

```cron
0 3 * * * cd /opt/whatsapp-automation && bash scripts/backup.sh >> /var/log/wa-backup.log 2>&1
```

Backups go to `backups/` and the script keeps the 14 most recent. For off-box
durability, add an `rsync` or `rclone` call after the dump:

```bash
# after the gzip line in backup.sh:
rclone copy "$out" r2:advoice-backups/db/ --quiet
```

---

## PM2 setup (first time only)

```bash
npm install -g pm2
pm2 start src/index.js --name wa-console --node-args="--env-file=.env"
pm2 save
pm2 startup  # follow the printed command to enable on reboot
```

---

## Environment variables

All secrets live in `.env` at the project root. Never commit this file.
Use `.env.example` as the template. Required vars:

| Key | Description |
|-----|-------------|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Long random string for JWT signing |
| `META_TOKEN` | WhatsApp Cloud API access token |
| `META_PHONE_NUMBER_ID` | From the Meta app dashboard |
| `META_APP_SECRET` | For webhook signature verification |
| `VERIFY_TOKEN` | Matches what you set on the Meta webhook |
| `ADMIN_EMAIL` | First admin account email |
| `ADMIN_PASSWORD` | Strong password (rotate after first login) |
| `GEMINI_API_KEY` or `OPENAI_API_KEY` | At least one AI provider key |
| `GEMINI_MODEL` / `OPENAI_MODEL` | Valid model id (e.g. `gemini-2.5-flash`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push (generate with `node scripts/generate-vapid.js`) |

---

## Monitoring

- **Health**: `GET /health` — always 200 while running
- **Readiness**: `GET /ready` — 503 if DB is unreachable
- **Ops panel**: Admin → Ops in the web console (admin login required)
- **Uptime monitor**: Point an external checker (UptimeRobot / Better Uptime) at `/health`
- **Logs**: `pm2 logs wa-console`

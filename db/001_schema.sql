-- Application state for the WhatsApp lead agent.
-- Loaded into the "app" database on first Postgres boot.
-- Safe to run by hand:  psql "$APP_DATABASE_URL" -f db/001_schema.sql
\connect app

-- Campaigns: one row per ad / service line.
-- match_text is the prefilled message from the Click-to-WhatsApp ad.
CREATE TABLE IF NOT EXISTS campaigns (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,              -- "Logo Design - Diwali 2026"
    service_key     TEXT NOT NULL,              -- "logo_design"
    match_text      TEXT NOT NULL,              -- "let me know more about logo design"
    drip_track      TEXT NOT NULL DEFAULT 'default',
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
    id                  SERIAL PRIMARY KEY,
    wa_id               TEXT NOT NULL UNIQUE,   -- WhatsApp phone number ID
    chatwoot_contact_id INTEGER,
    chatwoot_conv_id    INTEGER,
    campaign_id         INTEGER REFERENCES campaigns(id),
    ctwa_clid           TEXT,                   -- Meta ad click ID, first message only
    ad_source_id        TEXT,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_inbound_at     TIMESTAMPTZ,            -- drives the 24h window calculation
    drip_stage          INTEGER NOT NULL DEFAULT 0,   -- 0=none sent, 1=day3, 2=day5, 3=day8
    next_touch_at       TIMESTAMPTZ,
    drip_status         TEXT NOT NULL DEFAULT 'active',
                        -- active | replied | completed | opted_out | failed
    opted_out           BOOLEAN NOT NULL DEFAULT false,
    notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_due ON leads (next_touch_at)
    WHERE drip_status = 'active' AND opted_out = false;

-- Meta media IDs, so artwork is uploaded once and reused.
CREATE TABLE IF NOT EXISTS media_assets (
    id              SERIAL PRIMARY KEY,
    service_key     TEXT NOT NULL,
    filename        TEXT NOT NULL,
    media_type      TEXT NOT NULL,              -- image | document
    meta_media_id   TEXT,
    uploaded_at     TIMESTAMPTZ,
    expires_hint    TIMESTAMPTZ,                -- best-effort; always handle re-upload on failure
    source_path     TEXT,
    active          BOOLEAN NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_filename ON media_assets (service_key, filename);

-- Audit trail. Cheap, and invaluable when the client asks "why did it send that".
CREATE TABLE IF NOT EXISTS message_log (
    id              BIGSERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id),
    direction       TEXT NOT NULL,              -- inbound | outbound
    channel         TEXT NOT NULL,              -- ai | human | template
    template_name   TEXT,
    body            TEXT,
    meta_message_id TEXT,
    error_code      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_log_lead ON message_log (lead_id, created_at);

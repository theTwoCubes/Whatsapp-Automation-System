-- Seed campaigns. These match_text values MUST equal the ad prefill text
-- set in Meta Ads Manager for each Click-to-WhatsApp ad. Edit both together.
-- Replace the placeholder rows below with the client's real ad copy before launch.
\connect app

INSERT INTO campaigns (name, service_key, match_text, drip_track, active) VALUES
    ('Logo Design',       'logo_design',   'let me know more about logo design services', 'default', true),
    ('Branding Package',  'branding',      'i want to know about branding and identity', 'default', true),
    ('Poster Design',     'poster_design', 'tell me about poster design',                'default', true)
ON CONFLICT DO NOTHING;

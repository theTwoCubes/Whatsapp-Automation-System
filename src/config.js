import 'dotenv/config';

const required = [
  'META_PHONE_NUMBER_ID',
  'META_WABA_ID',
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'DATABASE_URL',
  'JWT_SECRET',
];

// Reads the environment and fails loudly if anything required is missing,
// so a bad .env stops us at boot instead of at the first request.
export function loadConfig() {
  const missing = required.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill these in.',
    );
  }

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got "${process.env.PORT}".`);
  }

  return {
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    wabaId: process.env.META_WABA_ID,
    accessToken: process.env.META_ACCESS_TOKEN,
    appSecret: process.env.META_APP_SECRET,
    verifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
    databaseUrl: process.env.DATABASE_URL,
    port,
    graphApiVersion: process.env.GRAPH_API_VERSION?.trim() || 'v21.0',

    // AI. Two providers are supported. AI_PROVIDER picks the primary, the other
    // is used as automatic failover. With no key the bot falls back to a canned
    // reply, so testing without a key still works.
    aiProvider: (process.env.AI_PROVIDER?.trim() || 'openai').toLowerCase(),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || '',
    openaiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || '',
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',

    // Embeddings are only used to match media to what a lead asked about.
    // Answers are not embedded, the whole pack is given to the model as text.
    embeddingModel: process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    // How much room the approved answers get in a prompt. The whole pack goes
    // in, so this is a ceiling rather than a target, and going over it drops
    // the least important entries rather than searching for the best ones.
    faqBudgetTokens: Number(process.env.FAQ_BUDGET_TOKENS || 6000),

    // How often the weekly learning pass runs, scanning new conversation
    // transcripts for facts to queue for review.
    learningIntervalDays: Number(process.env.LEARNING_INTERVAL_DAYS || 7),

    // Business identity injected into the system prompt.
    businessName: process.env.BUSINESS_NAME?.trim() || 'our studio',
    businessAbout: process.env.BUSINESS_ABOUT?.trim() || '',
    businessTone: process.env.BUSINESS_TONE?.trim() || 'friendly and professional',
    botName: process.env.BOT_NAME?.trim() || 'Adi',

    fallbackMessage:
      process.env.FALLBACK_MESSAGE?.trim() ||
      'Thanks for your message. Someone from our team will get back to you shortly.',
    handoffMessage:
      process.env.HANDOFF_MESSAGE?.trim() ||
      "Sure, I'm connecting you with someone from our team. They'll reply here shortly.",
    attachmentMessage:
      process.env.ATTACHMENT_MESSAGE?.trim() ||
      "Thanks for sending that over, I'm connecting you with someone from our team to take a look.",
    optOutMessage:
      process.env.OPT_OUT_MESSAGE?.trim() ||
      "Understood, you won't receive further messages from us. Reply anytime if you need help.",

    // Media resend cooldown, in minutes. Within this window the bot avoids
    // sending the same file to the same conversation again, but a lead who
    // genuinely asks for it once more is not hard blocked from it either.
    mediaResendCooldownMinutes: Number(process.env.MEDIA_RESEND_COOLDOWN_MINUTES || 180),

    // How many images/documents from the same lead get looked at with vision
    // per rolling hour, before the bot just stores the rest without analysing
    // them. Guards against someone running up the vision API bill (or trying
    // to smuggle a prompt injection through a wall of images).
    mediaAnalysisMaxPerHour: Number(process.env.MEDIA_ANALYSIS_MAX_PER_HOUR || 6),

    // Message batching. Rapid fire messages from the same lead are coalesced
    // into a single AI call instead of replying to each one separately.
    messageBatchDebounceMs: Number(process.env.MESSAGE_BATCH_DEBOUNCE_MS || 2500),
    messageBatchMaxWaitMs: Number(process.env.MESSAGE_BATCH_MAX_WAIT_MS || 8000),

    // Drip follow ups. Each entry is templateName:days. The template names must
    // match approved templates in WhatsApp Manager.
    dripSteps: parseDripSteps(process.env.DRIP_STEPS || ''),
    dripLanguage: process.env.DRIP_TEMPLATE_LANG?.trim() || 'en',

    // Console. The jwt secret signs agent logins. The admin pair seeds the first
    // login on boot if no agent exists.
    jwtSecret: process.env.JWT_SECRET.trim(),
    adminEmail: process.env.ADMIN_EMAIL?.trim() || '',
    adminPassword: process.env.ADMIN_PASSWORD?.trim() || '',

    // Minutes a human can sit on a chat before the bot resumes automatically.
    // 0 disables auto resume.
    resumeMinutes: Number(process.env.HANDOFF_RESUME_MINUTES || 0),

    // White label branding for the console. Editable in the console, these are
    // just the defaults.
    brandName: process.env.BRAND_NAME?.trim() || 'theTwoCubes',
    brandWatermark: process.env.BRAND_WATERMARK?.trim() || 'Made by theTwoCubes',
    supportEmail: process.env.SUPPORT_EMAIL?.trim() || 'build@thetwocubes.com',
    accentColor: process.env.ACCENT_COLOR?.trim() || '#00a884',

    // Contact facts the AI can share about the business itself (not a client's
    // website it is designing). Editable in the console under Setup.
    websiteUrl: process.env.WEBSITE_URL?.trim() || '',
    contactPhone: process.env.CONTACT_PHONE?.trim() || '',
    instagramUrl: process.env.INSTAGRAM_URL?.trim() || '',
  };
}

// Each entry is template:days, or template:days:mediaAssetId when the
// template's header needs a file attached (a portfolio PDF, for example).
export function parseDripSteps(raw) {
  return raw
    .split(',')
    .map((part, index) => {
      const [template, days, mediaAssetId] = part.split(':');
      return {
        step: index + 1,
        template: template.trim(),
        days: Number(days),
        mediaAssetId: mediaAssetId ? Number(mediaAssetId) : null,
      };
    })
    .filter((s) => s.template && Number.isFinite(s.days));
}

import 'dotenv/config';

const required = [
  'META_PHONE_NUMBER_ID',
  'META_WABA_ID',
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'DATABASE_URL',
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
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-1.5-flash',

    // Business identity injected into the system prompt.
    businessName: process.env.BUSINESS_NAME?.trim() || 'our studio',
    businessAbout: process.env.BUSINESS_ABOUT?.trim() || '',
    businessTone: process.env.BUSINESS_TONE?.trim() || 'friendly and professional',

    fallbackMessage:
      process.env.FALLBACK_MESSAGE?.trim() ||
      'Thanks for your message. Someone from our team will get back to you shortly.',
    handoffMessage:
      process.env.HANDOFF_MESSAGE?.trim() ||
      "Sure, I'm connecting you with someone from our team. They'll reply here shortly.",

    // Drip follow ups. Each entry is templateName:days. The template names must
    // match approved templates in WhatsApp Manager.
    dripSteps: parseDripSteps(process.env.DRIP_STEPS || 'drip_day3:3,drip_day5:5,drip_day8:8'),
    dripLanguage: process.env.DRIP_TEMPLATE_LANG?.trim() || 'en',

    // Console. The jwt secret signs agent logins. The admin pair seeds the first
    // login on boot if no agent exists.
    jwtSecret: process.env.JWT_SECRET?.trim() || 'dev-only-change-me',
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
  };
}

export function parseDripSteps(raw) {
  return raw
    .split(',')
    .map((part, index) => {
      const [template, days] = part.split(':');
      return { step: index + 1, template: template.trim(), days: Number(days) };
    })
    .filter((s) => s.template && Number.isFinite(s.days));
}

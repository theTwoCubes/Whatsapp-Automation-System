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
  };
}

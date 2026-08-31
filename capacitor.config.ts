import { CapacitorConfig } from '@capacitor/cli';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from the project root so DOMAIN is available during APK builds
config({ path: resolve(__dirname, '.env') });

const domain = process.env.DOMAIN || 'localhost:3000';
const url = domain.startsWith('http') ? domain : `https://${domain}`;

const cfg: CapacitorConfig = {
  appId: 'com.wamanager.console',
  appName: 'WA Manager',
  webDir: 'web/dist',
  server: {
    androidScheme: 'https',
    url,
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default cfg;

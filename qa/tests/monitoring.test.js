import test from 'node:test';
import assert from 'node:assert/strict';

import { initMonitoring, captureError } from '../../src/monitoring.js';

test('captureError is a safe no-op when SENTRY_DSN is not configured', () => {
  initMonitoring({ sentryDsn: '' });
  // Must not throw, and must not require a real Sentry connection.
  assert.doesNotThrow(() => captureError(new Error('boom'), { where: 'test' }));
});

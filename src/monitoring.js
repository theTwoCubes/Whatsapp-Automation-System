// Optional error tracking. A no-op everywhere until SENTRY_DSN is set, so a
// client without a Sentry account sees no behaviour change at all - this is
// purely additive to the existing pino logs, never a replacement for them.
import * as Sentry from '@sentry/node';

let enabled = false;

export function initMonitoring(config) {
  if (!config.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    // Error tracking only - no performance tracing/profiling, which would
    // pull in a lot more instrumentation than this needs.
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function captureError(err, context) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

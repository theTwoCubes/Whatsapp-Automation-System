// In-process operational counters shared between the message handler and the
// ops endpoint. Single instance, which is fine for a single-process server.

const state = {
  lastWebhookAt: null,
  aiOk: 0,
  aiErr: 0,
  // Exponential moving average of AI latency across all replies.
  aiLatencyAvgMs: null,
  metaLatencyAvgMs: null,
};

const EMA_ALPHA = 0.1;

function updateAvg(current, sample) {
  if (current === null) return sample;
  return Math.round(current * (1 - EMA_ALPHA) + sample * EMA_ALPHA);
}

export function recordWebhook() {
  state.lastWebhookAt = Date.now();
}

export function recordAiSuccess(latencyMs) {
  state.aiOk += 1;
  state.aiLatencyAvgMs = updateAvg(state.aiLatencyAvgMs, latencyMs);
}

export function recordAiError() {
  state.aiErr += 1;
}

export function recordMetaLatency(latencyMs) {
  state.metaLatencyAvgMs = updateAvg(state.metaLatencyAvgMs, latencyMs);
}

export function getStats() {
  const total = state.aiOk + state.aiErr;
  return {
    lastWebhookAt: state.lastWebhookAt,
    aiOk: state.aiOk,
    aiErr: state.aiErr,
    aiErrorRate: total > 0 ? Math.round((state.aiErr / total) * 1000) / 10 : 0,
    aiLatencyAvgMs: state.aiLatencyAvgMs,
    metaLatencyAvgMs: state.metaLatencyAvgMs,
  };
}

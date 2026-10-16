import { AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS, GEMINI_THINKING_BUDGET } from '../tuning.js';

// Google Gemini via the REST API, so no extra SDK dependency. Takes the same message shape as the OpenAI provider and returns raw text, throwing on error.
export class GeminiProvider {
  constructor(apiKey, model) {
    this.name = 'gemini';
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = 20000;
  }

  async complete(messages, options = {}) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const contents = coalesce(
      messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content ?? '' }] })),
    );

    const model = options.model ?? this.model;

    const body = {
      contents,
      generationConfig: {
        temperature: AI_TEMPERATURE,
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        // See tuning.js: reasoning tokens are billed against maxOutputTokens,
        // and this task gains nothing from deliberation that a lead would pay
        // for in waiting. Only sent to models that have the setting - the
        // model name is free text in the console, and an unknown field in
        // generationConfig is rejected outright rather than ignored, which
        // would take the provider down for anyone on an older model.
        ...(supportsThinking(model) ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } } : {}),
        ...(options.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message ?? `Gemini returned HTTP ${res.status}`);
    }
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini response was truncated by the output token limit');
    }
    return (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  }
}

// Thinking arrived with the 2.5 generation. Matches 2.5 and anything numbered
// above it, so a future model keeps the setting without this needing an edit,
// while 1.5 and 2.0 are left alone.
export function supportsThinking(model) {
  return /gemini-(?:2\.5|[3-9](?:\.|-|$))/i.test(String(model || ''));
}

// Gemini needs the turns to alternate, so merge any consecutive same role turns.
function coalesce(turns) {
  const out = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.parts[0].text += `\n${turn.parts[0].text}`;
    } else {
      out.push({ role: turn.role, parts: [{ text: turn.parts[0].text }] });
    }
  }
  return out;
}

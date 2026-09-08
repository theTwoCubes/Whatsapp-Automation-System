// Google Gemini via the REST API, so no extra SDK dependency. Takes the same
// message shape as the OpenAI provider and returns raw text, throwing on error.
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

    const body = {
      contents,
      generationConfig: {
        temperature: 0.6,
        // Was 400 - too tight for a longer reply or a non-Latin script
        // (Hindi/Gujarati costs far more tokens per sentence than English),
        // which truncated the JSON mid-string with no error, wrongly read
        // downstream as an unconditional handoff instead of a real failure.
        maxOutputTokens: 1024,
        ...(options.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const model = options.model ?? this.model;
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
    // A truncated response is not usable output, but it also isn't a thrown
    // error by default - throwing here is what lets AiClient fail over to
    // the other provider instead of silently treating garbage JSON as a
    // deliberate handoff.
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini response was truncated by the output token limit');
    }
    return (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  }
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

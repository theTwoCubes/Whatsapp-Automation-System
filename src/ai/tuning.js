// Sampling settings shared by every provider, so the two can never drift
// apart and have the same prompt behave differently depending on which one
// happened to answer. Lives in its own module rather than on the AiClient
// because the providers would otherwise have to import from the thing that
// imports them.

// What the model is asked to do on each turn is pick one action, fill a set of
// fields that have to be exactly right, and write two sentences that obey a
// long list of rules. None of that wants a high temperature. The warmth in
// the replies comes from the prompt describing how to talk; turning the
// sampler up does not make it friendlier, it makes it less obedient.
//
// At 0.6 this prompt produced invented process stages, improvised payment
// wording, and an English reply on a turn where the model had itself
// correctly identified the language as Hinglish.
export const AI_TEMPERATURE = 0.3;

// Plenty for one JSON object holding a short reply - the cap exists so a
// runaway generation fails fast rather than billing for thousands of tokens.
// Both providers throw when they hit it, which fails over instead of handing
// back half an object.
export const AI_MAX_OUTPUT_TOKENS = 4096;

// Gemini's configured model reasons before answering by default, and those
// reasoning tokens are billed against the output cap above - the same thing
// that once stored a truncated image description as though it were complete.
// This task does not need deliberation: the judgement is in the rules it has
// been given, and every extra second of thinking is a second a customer spends
// watching nothing happen. If replies ever need more deliberation than this,
// a stronger model is the lever, not a thinking budget on a fast one.
export const GEMINI_THINKING_BUDGET = 0;

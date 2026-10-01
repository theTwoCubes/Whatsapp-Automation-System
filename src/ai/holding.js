// Last-resort holding line used by the qualification-gate downgrade path
// when either (a) the regen AI call fails outright, or (b) the model
// stubbornly returns handoff a second time with its misleading "connecting
// you" text. Shared between src/handlers/message.js (live respondToLead)
// and src/scheduler.js (auto-resume + manual handback catch-up) so a tweak
// to the wording cannot drift between the two call sites.
// Deliberately NOT the "connecting you with a person now" settings fallback - the whole point of the downgrade is that we are not connecting anyone yet, so the holding line asks for the missing qualification details instead.

export const DOWNGRADE_HOLDING_MESSAGE = 
  "Could you share your name and a bit about what your business is or what you're looking for? That helps me point you to the right thing.";

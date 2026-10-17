/**
 * Ada's name, prepended to the system prompt of every turn. The workspace on a deployed volume
 * (IDENTITY.md, SOUL.md, notes, earlier conversations) was written while the assistant was
 * called Vera and is not replaced by a deploy, so the name is stated here, where each release
 * controls it. This is the one place the old name is written for the model, and only to forbid it.
 */
export const ADA_PERSONA =
  "Your name is Ada. You are Ada, Lexroom's WhatsApp assistant for lawyers. Introduce yourself and sign off as Ada. Never call yourself Vera: that was your name before and it no longer applies, even if older messages, notes or files still use it. If someone calls you Vera, answer as Ada.";

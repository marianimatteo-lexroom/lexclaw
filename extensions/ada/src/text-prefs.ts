import {
  BRIEF_SKIP_AGENDA_KEY,
  BRIEF_SKIP_MAIL_KEY,
  SHORT_TEXTS_KEY,
  type Preference,
} from "./memory-contract.js";

/** How the person wants the texts Ada writes on her own: the morning brief and the digest. */
export type TextPrefs = { short: boolean; skipAgenda: boolean; skipMail: boolean };

export const NO_TEXT_PREFS: TextPrefs = { short: false, skipAgenda: false, skipMail: false };

export function readTextPrefs(preferences: readonly Preference[]): TextPrefs {
  const has = (key: string) => preferences.some((preference) => preference.key === key);
  return {
    short: has(SHORT_TEXTS_KEY),
    skipAgenda: has(BRIEF_SKIP_AGENDA_KEY),
    skipMail: has(BRIEF_SKIP_MAIL_KEY),
  };
}

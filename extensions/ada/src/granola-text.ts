import type { Language } from "./research-link-outbound.js";

/** Messages Ada's code sends about Granola without a model turn, in the person's latest language. */
const CONNECTED: Record<Language, string> = {
  it: "Granola è collegato. Posso leggere i tuoi appunti e le trascrizioni delle riunioni, solo in lettura.",
  en: "Granola is connected. I can read your meeting notes and transcripts, read only.",
  es: "Granola está conectado. Puedo leer tus notas y transcripciones de reuniones, solo en lectura.",
  fr: "Granola est connecté. Je peux lire vos notes et transcriptions de réunions, en lecture seule.",
  de: "Granola ist verbunden. Ich kann Ihre Besprechungsnotizen und Transkripte lesen, nur lesend.",
};

const RECONNECT: Record<Language, (url: string) => string> = {
  it: (url) =>
    `Il collegamento a Granola è scaduto: ecco il link per ricollegarlo (vale 30 minuti)\n${url}`,
  en: (url) =>
    `The Granola connection expired: here is the link to reconnect it (valid for 30 minutes)\n${url}`,
  es: (url) =>
    `La conexión con Granola ha caducado: aquí tienes el enlace para volver a conectarla (vale 30 minutos)\n${url}`,
  fr: (url) =>
    `La connexion à Granola a expiré : voici le lien pour la reconnecter (valable 30 minutes)\n${url}`,
  de: (url) =>
    `Die Verbindung zu Granola ist abgelaufen: hier ist der Link zum erneuten Verbinden (30 Minuten gültig)\n${url}`,
};

export const granolaConnectedText = (language: Language): string => CONNECTED[language];

export const granolaReconnectText = (language: Language, url: string): string =>
  RECONNECT[language](url);

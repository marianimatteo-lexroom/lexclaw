import type { Language } from "./research-link-outbound.js";

/** Messages Ada's code sends about Outlook without a model turn, in the person's latest language. */
const CONNECTED: Record<Language, string> = {
  it: "Outlook è collegato. Posso leggere la tua posta e il tuo calendario, e inviare email o creare eventi solo dopo la tua conferma.",
  en: "Outlook is connected. I can read your mail and calendar, and I only send mail or create events after you confirm.",
  es: "Outlook está conectado. Puedo leer tu correo y tu calendario, y solo envío correos o creo eventos después de tu confirmación.",
  fr: "Outlook est connecté. Je peux lire votre messagerie et votre agenda, et je n'envoie un e-mail ou ne crée un événement qu'après votre confirmation.",
  de: "Outlook ist verbunden. Ich kann Ihre E-Mails und Ihren Kalender lesen und sende E-Mails oder lege Termine nur nach Ihrer Bestätigung an.",
};

const RECONNECT: Record<Language, (url: string) => string> = {
  it: (url) =>
    `Il collegamento a Outlook è scaduto: ecco il link per ricollegarlo (vale 30 minuti)\n${url}`,
  en: (url) =>
    `The Outlook connection expired: here is the link to reconnect it (valid for 30 minutes)\n${url}`,
  es: (url) =>
    `La conexión con Outlook ha caducado: aquí tienes el enlace para volver a conectarla (vale 30 minutos)\n${url}`,
  fr: (url) =>
    `La connexion à Outlook a expiré : voici le lien pour la reconnecter (valable 30 minutes)\n${url}`,
  de: (url) =>
    `Die Verbindung zu Outlook ist abgelaufen: hier ist der Link zum erneuten Verbinden (30 Minuten gültig)\n${url}`,
};

const ADMIN_CONSENT: Record<Language, string> = {
  it: "Non è stato possibile collegare Outlook: la tua organizzazione richiede che l'amministratore IT dell'azienda approvi prima l'app Ada in Microsoft. Chiedigli di approvarla; quando lo ha fatto scrivimi e riproviamo. Finché non è approvata, un nuovo link non servirebbe.",
  en: "Outlook could not be connected: your organization requires your company's IT admin to approve the Ada app in Microsoft first. Ask them to approve it, and write to me once they have so we can try again. Until it is approved, a new link would not help.",
  es: "No fue posible conectar Outlook: tu organización exige que el administrador de TI de la empresa apruebe antes la app Ada en Microsoft. Pídele que la apruebe y escríbeme cuando lo haya hecho para volver a intentarlo. Mientras no esté aprobada, un enlace nuevo no serviría.",
  fr: "Impossible de connecter Outlook : votre organisation exige que l'administrateur informatique de l'entreprise approuve d'abord l'application Ada dans Microsoft. Demandez-lui de l'approuver, puis écrivez-moi quand c'est fait pour réessayer. Tant qu'elle n'est pas approuvée, un nouveau lien ne servirait à rien.",
  de: "Outlook konnte nicht verbunden werden: Ihre Organisation verlangt, dass der IT-Administrator Ihres Unternehmens die Ada-App zuerst in Microsoft genehmigt. Bitten Sie ihn darum und schreiben Sie mir, sobald das erledigt ist, dann versuchen wir es erneut. Solange sie nicht genehmigt ist, würde ein neuer Link nicht helfen.",
};

export const outlookConnectedText = (language: Language): string => CONNECTED[language];

export const outlookReconnectText = (language: Language, url: string): string =>
  RECONNECT[language](url);

export const outlookAdminConsentText = (language: Language): string => ADMIN_CONSENT[language];

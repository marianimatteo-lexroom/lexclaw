import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  ADA_WHATSAPP_CHANNEL,
  isConfiguredLawyerSender,
  normalizeWhatsAppNumber,
  sendAdaWhatsAppText,
} from "./google-notify.js";
import {
  firstName,
  isOptOutText,
  maskPhone,
  maskPhonesInText,
  parseRecipientList,
  type ParsedList,
  type Recipient,
} from "./outreach-parse.js";
import {
  sendKapsoTemplate,
  type KapsoTemplate,
  type KapsoTemplateResult,
} from "./whatsapp-template.js";

/**
 * Admin-only batch outreach: an admin hands Ada a list of numbers, confirms, and Ada sends each
 * one the approved intro template, one message per second. A recipient who answers starts an
 * ordinary conversation with Ada and never sees anyone else on the list. The feature exists only
 * while `ADA_ADMIN_NUMBERS` is set; for everyone else Ada behaves exactly as before.
 */

const COMMAND_SEND = /^\/invia-intro(?=\s|$)/iu;
/** An attached file is a list only when its caption names the command. */
const COMMAND_IN_CAPTION = /\/invia-intro(?=\s|$)/iu;
/** Key of the one batch allowed to exist at a time, across all admins. */
const ACTIVE_BATCH = "active";
const COMMAND_CANCEL = /^\/annulla$/iu;
const CONFIRM_WORD = /^conferma[.!]*$/iu;
const PENDING_TTL_MS = 30 * 60_000;
const SENT_SKIP_MS = 30 * 24 * 60 * 60_000;
const THROTTLE_MS = 1000;
/** Meta's first messaging tier lets a business start 1,000 conversations a day. */
const MAX_RECIPIENTS = 1000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_STASHED_DOCUMENTS = 20;
const LIST_FILE = /(?:^text\/(?:csv|plain)\b|^application\/csv\b|\.(?:csv|txt)$)/iu;

export type OutreachConfig = {
  /** Digits of every number allowed to run outreach. */
  admins: ReadonlySet<string>;
  template: { name: string; language: string };
  /** First-name stand-in for a row without a name; Meta rejects an empty variable. */
  defaultName: string;
  /** Body variables the template declares: 1 for `{{1}}` = first name, 0 for none. */
  paramCount: 0 | 1;
};

type Store<T> = {
  register(key: string, value: T): Promise<void>;
  registerIfAbsent(key: string, value: T): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

type SentRecord = { at: number; batchId: string; status: "claimed" | "sent" };
type Pending = { expiresAt: number; recipients: Recipient[] };
type Batch = {
  /** Tells this batch's sent records apart from an earlier batch's. */
  id: string;
  admin: string;
  status: "running" | "cancelled";
  config: Pick<OutreachConfig, "template" | "defaultName" | "paramCount">;
  recipients: Recipient[];
  /** Index of the next row to handle; a row is never retried once it has been claimed. */
  cursor: number;
  sent: number;
  skipped: number;
  optedOut: number;
  unconfirmed: number;
  failures: Record<string, number>;
};

/** Retained, so an opt-out or a sent record is never evicted to make room. */
export type OutreachStore = {
  optOut: Store<{ at: number }>;
  sent: Store<SentRecord>;
  pending: Store<Pending>;
  batches: Store<Batch>;
};

export type OutreachDeps = {
  send: (to: string, template: KapsoTemplate) => Promise<KapsoTemplateResult>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
};

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Null when `ADA_ADMIN_NUMBERS` names nobody: the feature is off. */
export function readOutreachConfig(env: NodeJS.ProcessEnv): OutreachConfig | null {
  const admins = new Set<string>();
  for (const entry of (envValue(env, "ADA_ADMIN_NUMBERS") ?? "").split(",")) {
    const digits = normalizeWhatsAppNumber(entry);
    if (digits) {
      admins.add(digits);
    }
  }
  if (admins.size === 0) {
    return null;
  }
  return {
    admins,
    template: {
      name: envValue(env, "ADA_INTRO_TEMPLATE_NAME") ?? "ada_intro",
      language: envValue(env, "ADA_INTRO_TEMPLATE_LANG") ?? "it",
    },
    defaultName: envValue(env, "ADA_INTRO_DEFAULT_NAME") ?? "gentile utente",
    paramCount: envValue(env, "ADA_INTRO_TEMPLATE_PARAMS") === "0" ? 0 : 1,
  };
}

function openOutreachStore(api: Pick<OpenClawPluginApi, "runtime">): OutreachStore {
  const open = <T>(namespace: string): Store<T> =>
    api.runtime.state.openKeyedStore<T>({ namespace, retention: "retained" });
  return {
    optOut: open("ada-outreach-opt-out"),
    sent: open("ada-outreach-sent"),
    pending: open("ada-outreach-pending"),
    batches: open("ada-outreach-batches"),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

async function planBatch(
  store: OutreachStore,
  list: ParsedList,
  now: number,
): Promise<{ recipients: Recipient[]; optedOut: number; recent: number }> {
  const plan = { recipients: [] as Recipient[], optedOut: 0, recent: 0 };
  for (const recipient of list.recipients) {
    const sent = await store.sent.lookup(recipient.phone);
    if (await store.optOut.lookup(recipient.phone)) {
      plan.optedOut += 1;
    } else if (sent && now - sent.at < SENT_SKIP_MS) {
      plan.recent += 1;
    } else {
      plan.recipients.push(recipient);
    }
  }
  return plan;
}

function describeBatch(
  config: OutreachConfig,
  list: ParsedList,
  plan: { recipients: Recipient[]; optedOut: number; recent: number },
): string {
  const lines = [
    `Elenco letto. Validi: ${plan.recipients.length}. Non validi: ${list.invalid}. Duplicati: ${list.duplicates}. Disiscritti: ${plan.optedOut}.`,
  ];
  if (plan.recent > 0) {
    lines.push(`Già contattati negli ultimi 30 giorni (saltati): ${plan.recent}.`);
  }
  if (plan.recipients.length === 0) {
    lines.push("Non c'è nessun numero da contattare, quindi non invio nulla.");
    return lines.join("\n");
  }
  const examples = plan.recipients.slice(0, 3).map((recipient) => maskPhone(recipient.phone));
  lines.push(
    `Esempi: ${examples.join(", ")}.`,
    `Invierò il modello «${config.template.name}» (${config.template.language}) a ${plan.recipients.length} numeri, circa uno al secondo.`,
    "Per procedere rispondi CONFERMA entro 30 minuti, oppure /annulla per fermarmi. Senza conferma non invio nulla.",
  );
  return lines.join("\n");
}

function describeResult(batch: Batch): string {
  const failed = Object.values(batch.failures).reduce((total, count) => total + count, 0);
  const lines = [
    `${batch.status === "cancelled" ? "Invio interrotto" : "Invio terminato"}: ${plural(batch.sent, "messaggio inviato", "messaggi inviati")}, ${plural(failed, "non riuscito", "non riusciti")}.`,
  ];
  if (failed > 0) {
    lines.push(
      `Motivi: ${Object.entries(batch.failures)
        .map(([reason, count]) => `${reason} (${count})`)
        .join("; ")}.`,
    );
  }
  if (batch.skipped > 0) {
    lines.push(`Saltati perché già contattati di recente: ${batch.skipped}.`);
  }
  if (batch.optedOut > 0) {
    lines.push(`Saltati perché si sono disiscritti nel frattempo: ${batch.optedOut}.`);
  }
  if (batch.unconfirmed > 0) {
    lines.push(
      `Non confermati: ${batch.unconfirmed}. Il servizio si è riavviato durante l'invio e non li ho rimandati, per non scrivere due volte alla stessa persona.`,
    );
  }
  return lines.join("\n");
}

async function readListFile(path: string): Promise<string | undefined> {
  const bytes = await readFile(path).catch(() => undefined);
  return bytes && bytes.length <= MAX_FILE_BYTES ? bytes.toString("utf8") : undefined;
}

/** Everything the admin can say to Ada about outreach; undefined means it is not about outreach. */
async function handleAdminMessage(
  ctx: {
    config: OutreachConfig;
    store: OutreachStore;
    now: () => number;
    startBatch: () => void;
    cancelBatch: () => Promise<void>;
  },
  admin: string,
  text: string,
  documentPath: string | undefined,
): Promise<string | undefined> {
  const { config, store } = ctx;
  const isSend = COMMAND_SEND.test(text);
  if (COMMAND_CANCEL.test(text)) {
    if (await store.pending.consume(admin)) {
      return "Annullato: non invio nulla.";
    }
    if (await store.batches.lookup(ACTIVE_BATCH)) {
      await ctx.cancelBatch();
      return "Fermo l'invio. I messaggi già partiti restano inviati; ti scrivo il riepilogo tra poco.";
    }
    return "Non c'è nessun invio in sospeso.";
  }

  if (CONFIRM_WORD.test(text) && !isSend) {
    const pending = await store.pending.consume(admin);
    if (!pending) {
      return undefined;
    }
    if (pending.expiresAt <= ctx.now()) {
      return "La conferma è arrivata troppo tardi (30 minuti): rimanda l'elenco e ripartiamo.";
    }
    const started = await store.batches.registerIfAbsent(ACTIVE_BATCH, {
      id: randomUUID(),
      admin,
      status: "running",
      config: {
        template: config.template,
        defaultName: config.defaultName,
        paramCount: config.paramCount,
      },
      recipients: pending.recipients,
      cursor: 0,
      sent: 0,
      skipped: 0,
      optedOut: 0,
      unconfirmed: 0,
      failures: {},
    });
    if (!started) {
      await store.pending.register(admin, pending);
      return "C'è già un invio in corso, avviato da un admin: ne parte uno solo alla volta. Aspetta il riepilogo; la tua lista resta in attesa finché non scade, poi rispondi di nuovo CONFERMA.";
    }
    ctx.startBatch();
    return `Confermato. Invio a ${pending.recipients.length} numeri, circa uno al secondo. Ti scrivo il riepilogo a fine invio; /annulla per fermarmi.`;
  }

  let source: string | undefined;
  if (documentPath && COMMAND_IN_CAPTION.test(text)) {
    source = await readListFile(documentPath);
    if (source === undefined) {
      return "Non riesco a leggere il file (CSV o TXT, al massimo 512 KB). Incolla i numeri nel messaggio dopo /invia-intro, uno per riga.";
    }
  } else if (isSend) {
    source = text.replace(COMMAND_SEND, "");
  }
  if (source === undefined) {
    return undefined;
  }
  if (await store.batches.lookup(ACTIVE_BATCH)) {
    return "C'è già un invio in corso. Aspetta il riepilogo oppure usa /annulla per fermarlo.";
  }
  const list = parseRecipientList(source);
  if (list.recipients.length === 0 && list.invalid === 0) {
    return "Non ho trovato numeri. Scrivi /invia-intro seguito dai numeri, uno per riga (anche «numero,nome»), oppure mandami un file CSV o TXT.";
  }
  if (list.recipients.length > MAX_RECIPIENTS) {
    return `Troppi numeri: al massimo ${MAX_RECIPIENTS} per invio. Dividi l'elenco.`;
  }
  const plan = await planBatch(store, list, ctx.now());
  if (plan.recipients.length > 0) {
    await store.pending.register(admin, {
      expiresAt: ctx.now() + PENDING_TTL_MS,
      recipients: plan.recipients,
    });
  } else {
    await store.pending.delete(admin);
  }
  return describeBatch(config, list, plan);
}

async function runBatch(params: {
  store: OutreachStore;
  deps: OutreachDeps;
  signal: AbortSignal;
  notify: (admin: string, text: string) => Promise<void>;
  log: OpenClawPluginApi["logger"];
  /** Called before the finished batch is removed, so the next one may start. */
  release: () => void;
}): Promise<void> {
  const { store, deps, signal } = params;
  let batch = await store.batches.lookup(ACTIVE_BATCH);
  while (batch && batch.status === "running" && batch.cursor < batch.recipients.length) {
    if (signal.aborted) {
      break;
    }
    const row = batch.recipients[batch.cursor];
    if (!row) {
      break;
    }
    const id = batch.id;
    const prior = await store.sent.lookup(row.phone);
    let sentNow = false;
    if (prior?.batchId === id) {
      // A restart interrupted this row. A claim without an outcome may have gone out, and a
      // second intro to the same person is worse than a missed one.
      if (prior.status === "sent") {
        batch.sent += 1;
      } else {
        batch.unconfirmed += 1;
      }
    } else if (await store.optOut.lookup(row.phone)) {
      // A STOP may have arrived after the list was confirmed.
      batch.optedOut += 1;
    } else if (prior && deps.now() - prior.at < SENT_SKIP_MS) {
      batch.skipped += 1;
    } else {
      await store.sent.register(row.phone, { at: deps.now(), batchId: id, status: "claimed" });
      const name = firstName(row.name) ?? batch.config.defaultName;
      const result = await deps.send(row.phone, {
        ...batch.config.template,
        ...(batch.config.paramCount > 0 ? { params: [name] } : {}),
      });
      sentNow = true;
      if (result.ok) {
        await store.sent.register(row.phone, { at: deps.now(), batchId: id, status: "sent" });
        batch.sent += 1;
      } else {
        await store.sent.delete(row.phone);
        const reason = maskPhonesInText(result.error);
        batch.failures[reason] = (batch.failures[reason] ?? 0) + 1;
        params.log.debug?.(`ada outreach send failed for ${maskPhone(row.phone)}: ${reason}`);
      }
    }
    batch.cursor += 1;
    if (signal.aborted && signal.reason === "cancel") {
      batch.status = "cancelled";
    }
    await store.batches.register(ACTIVE_BATCH, batch);
    if (sentNow && !signal.aborted && batch.cursor < batch.recipients.length) {
      await deps.sleep(THROTTLE_MS, signal);
    }
    // /annulla may have written the cancellation while this row was being sent.
    const latest = await store.batches.lookup(ACTIVE_BATCH);
    batch = latest && latest.status !== "running" ? latest : batch;
  }
  if (!batch || (signal.aborted && signal.reason !== "cancel")) {
    return;
  }
  if (signal.aborted) {
    batch.status = "cancelled";
  }
  await params.notify(batch.admin, describeResult(batch));
  params.release();
  await store.batches.delete(ACTIVE_BATCH);
  params.log.info(
    `ada outreach batch finished status=${batch.status} sent=${batch.sent} skipped=${batch.skipped} unconfirmed=${batch.unconfirmed}`,
  );
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Registers outreach for this gateway; does nothing at all while `ADA_ADMIN_NUMBERS` is unset. */
export function registerAdaOutreach(
  api: OpenClawPluginApi,
  options: { env?: NodeJS.ProcessEnv; deps?: Partial<OutreachDeps>; store?: OutreachStore } = {},
): void {
  const config = readOutreachConfig(options.env ?? process.env);
  if (!config) {
    return;
  }
  const deps: OutreachDeps = {
    send: (to, template) => sendKapsoTemplate({ config: api.config, to, template }),
    sleep: abortableSleep,
    now: Date.now,
    ...options.deps,
  };
  let store: OutreachStore | undefined;
  const getStore = () => (store ??= options.store ?? openOutreachStore(api));
  let current: AbortController | undefined;
  const documents = new Map<string, string>();

  const notify = async (admin: string, text: string) => {
    const result = await sendAdaWhatsAppText({ api, to: admin, text });
    if (!result.ok) {
      api.logger.warn(`ada outreach could not message the admin: ${result.error}`);
    }
  };
  const startBatch = () => {
    if (current) {
      return;
    }
    const controller = new AbortController();
    current = controller;
    const release = () => {
      if (current === controller) {
        current = undefined;
      }
    };
    runBatch({
      store: getStore(),
      deps,
      signal: controller.signal,
      notify,
      log: api.logger,
      release,
    })
      .catch((error: unknown) => {
        api.logger.error(
          `ada outreach batch failed: ${error instanceof Error ? maskPhonesInText(error.message) : "unknown"}`,
        );
      })
      .finally(release);
  };
  const cancelBatch = async () => {
    const batch = await getStore().batches.lookup(ACTIVE_BATCH);
    if (batch) {
      await getStore().batches.register(ACTIVE_BATCH, { ...batch, status: "cancelled" });
    }
    if (current) {
      current.abort("cancel");
    } else {
      startBatch();
    }
  };

  const senderOf = (...senders: unknown[]): string | undefined =>
    senders.map((sender) => normalizeWhatsAppNumber(sender)).find((digits) => digits !== null) ??
    undefined;

  api.on("message_received", async (event, ctx) => {
    if (ctx.channelId !== ADA_WHATSAPP_CHANNEL) {
      return;
    }
    const sender = senderOf(ctx.senderId, event.from);
    if (!sender) {
      return;
    }
    const messageId = ctx.messageId ?? event.messageId;
    const file = event.media?.find(
      (fact) => fact.path && (LIST_FILE.test(fact.contentType ?? "") || LIST_FILE.test(fact.path)),
    );
    if (config.admins.has(sender) && messageId && file?.path) {
      documents.set(messageId, file.path);
      const oldest = documents.keys().next();
      if (documents.size > MAX_STASHED_DOCUMENTS && !oldest.done) {
        documents.delete(oldest.value);
      }
    }
    if (
      isOptOutText(event.content) &&
      !isConfiguredLawyerSender(api.config, ctx.senderId, event.from)
    ) {
      await getStore().optOut.register(`+${sender}`, { at: deps.now() });
      api.logger.info(`ada outreach opt-out recorded for ${maskPhone(`+${sender}`)}`);
      await notify(
        sender,
        "Fatto: non ti scriverò più di mia iniziativa. Se ti serve qualcosa, scrivimi quando vuoi. Ada",
      );
    }
  });

  api.on("before_dispatch", async (event, ctx) => {
    if ((ctx.channelId ?? event.channel) !== ADA_WHATSAPP_CHANNEL || event.isGroup === true) {
      return;
    }
    const sender = senderOf(ctx.senderId, event.senderId);
    if (!sender) {
      return;
    }
    const text = event.content.trim();
    // The opt-out confirmation was already sent when the message arrived; Ada stays quiet here.
    if (isOptOutText(text) && !isConfiguredLawyerSender(api.config, ctx.senderId, event.senderId)) {
      return { handled: true };
    }
    if (!config.admins.has(sender)) {
      return;
    }
    const messageId = ctx.messageId ?? event.messageId;
    const documentPath = messageId ? documents.get(messageId) : undefined;
    if (messageId) {
      documents.delete(messageId);
    }
    const reply = await handleAdminMessage(
      { config, store: getStore(), now: deps.now, startBatch, cancelBatch },
      sender,
      text,
      documentPath,
    );
    return reply === undefined ? undefined : { handled: true, text: reply };
  });

  api.registerService({
    id: "ada-outreach",
    async start() {
      // A batch interrupted by a restart picks up at its saved row.
      if (await getStore().batches.lookup(ACTIVE_BATCH)) {
        startBatch();
      }
    },
    stop() {
      current?.abort("stop");
    },
  });
}

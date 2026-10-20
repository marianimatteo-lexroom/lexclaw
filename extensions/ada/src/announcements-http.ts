import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  deliverToRecipients,
  indexDeliveries,
  listAnnouncementRecipients,
  liveAnnouncementDeps,
  outcomeView,
  parseAnnouncementInput,
  type AnnouncementDeps,
  type AnnouncementRecipient,
} from "./announcements.js";
import { denyAdminAccess, writeJson, writeText } from "./feedback-http.js";
import { adminNumberView } from "./feedback.js";
import { registerAdaHttpRoute } from "./http-paths.js";
import type { Announcement, AnnouncementDelivery } from "./memory-contract.js";

const MAX_BODY_BYTES = 16 * 1024;
const ANNOUNCEMENTS_PATH = /^(?:\/(?:ada|vera))?\/admin\/announcements\/?$/u;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const announcementView = (announcement: Announcement) => ({
  id: announcement.id,
  feature: announcement.feature,
  languages: Object.keys(announcement.texts),
  createdAt: new Date(announcement.createdAtMs).toISOString(),
});

type Counts = { sent: number; skipped: number; pending: number };

function deliveryRow(number: string, delivery: AnnouncementDelivery | undefined) {
  const status: keyof Counts = delivery?.status ?? "pending";
  return {
    ...adminNumberView(number),
    status,
    reason: delivery?.reason ?? null,
    at: delivery ? new Date(delivery.atMs).toISOString() : null,
  };
}

/** Every announcement with what each known number has had of it, from the delivery rows alone. */
async function listView(deps: AnnouncementDeps, recipients: readonly AnnouncementRecipient[]) {
  const registry = await deps.registry();
  const [announcements, deliveries] = await Promise.all([
    registry.listAnnouncements(),
    registry.listAnnouncementDeliveries(),
  ]);
  const deliveryOf = indexDeliveries(deliveries);
  return announcements.map((announcement) => {
    const numbers = new Set(recipients.map((recipient) => recipient.owner));
    for (const delivery of deliveries) {
      if (delivery.announcementId === announcement.id) {
        numbers.add(delivery.number);
      }
    }
    const rows = [...numbers]
      .toSorted()
      .map((number) => deliveryRow(number, deliveryOf(announcement.id, number)));
    const counts: Counts = { sent: 0, skipped: 0, pending: 0 };
    for (const row of rows) {
      counts[row.status] += 1;
    }
    return Object.assign(announcementView(announcement), { counts, recipients: rows });
  });
}

/**
 * The team's channel for product news. `POST /admin/announcements` with
 * `{"id":"<slug>","texts":{"it":"…","en":"…"},"feature":"granola","dryRun":true}` shows who would
 * get what without sending or saving; without `dryRun` it saves the announcement and delivers it
 * to every number inside its 24-hour window (the others get it after their next answered
 * message). `GET` lists the announcements with each number's delivery status. Disabled (404)
 * unless `ADA_ADMIN_TOKEN` is set; every request then needs that bearer token.
 */
export async function handleAdaAnnouncementsAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    env: NodeJS.ProcessEnv;
    delivery: AnnouncementDeps;
    recipients: () => AnnouncementRecipient[];
    log: { error: (message: string) => void };
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!ANNOUNCEMENTS_PATH.test(url.pathname)) {
    writeText(res, 404, "not found");
    return true;
  }
  if (denyAdminAccess(req, res, deps.env)) {
    return true;
  }
  try {
    if (req.method === "GET") {
      writeJson(res, 200, {
        ok: true,
        announcements: await listView(deps.delivery, deps.recipients()),
      });
      return true;
    }
    if (req.method === "POST") {
      const parsed = parseAnnouncementInput(await readJsonBody(req), deps.delivery.now());
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return true;
      }
      const { announcement, dryRun } = parsed;
      if (!dryRun && !(await (await deps.delivery.registry()).saveAnnouncement(announcement))) {
        writeJson(res, 409, { ok: false, error: "an announcement with this id already exists" });
        return true;
      }
      const results = await deliverToRecipients(deps.delivery, announcement, deps.recipients(), {
        dryRun,
      });
      writeJson(res, dryRun ? 200 : 201, {
        ok: true,
        dryRun,
        announcement: announcementView(announcement),
        recipients: results.map(({ recipient, outcome }) => outcomeView(recipient.owner, outcome)),
      });
      return true;
    }
    res.setHeader("allow", "GET, POST");
    writeText(res, 405, "method not allowed");
  } catch (error) {
    deps.log.error(
      `ada announcements admin failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    writeText(res, 500, "announcements unavailable");
  }
  return true;
}

/** Serves the admin announcements endpoint on `/admin/announcements` and under the `/ada` and `/vera` prefixes. */
export function registerAdaAnnouncementsAdmin(api: OpenClawPluginApi): void {
  const route = {
    path: "/admin/announcements",
    auth: "plugin",
    match: "prefix",
    handler: (req: IncomingMessage, res: ServerResponse) =>
      handleAdaAnnouncementsAdmin(req, res, {
        env: process.env,
        delivery: liveAnnouncementDeps(api),
        recipients: () => listAnnouncementRecipients(api),
        log: api.logger,
      }),
  } as const;
  api.registerHttpRoute(route);
  registerAdaHttpRoute(api, route);
}

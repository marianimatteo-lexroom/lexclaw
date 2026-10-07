import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { planDigest, type DigestSignal } from "./src/digest.js";
import { runDraft, runResearch, type LexroomConfig } from "./src/lexroom-client.js";

const signalSchema = Type.Object(
  {
    matterId: Type.String({ minLength: 1, description: "Stable id for one client or matter." }),
    matterLabel: Type.String({ minLength: 1, description: "Name safe to show the lawyer." }),
    kind: Type.Union([
      Type.Literal("deadline"),
      Type.Literal("calendar_move"),
      Type.Literal("overnight_email"),
      Type.Literal("decision_waiting"),
    ]),
    summary: Type.String({
      minLength: 1,
      description: "What changed, using facts from this matter only.",
    }),
    dueAt: Type.Optional(Type.String({ description: "ISO-8601 time the lawyer would miss." })),
    movedCloser: Type.Optional(
      Type.Boolean({ description: "True when a calendar item moved earlier." }),
    ),
    needsDecision: Type.Optional(
      Type.Boolean({ description: "True when the lawyer has to decide or reply." }),
    ),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "vera",
  name: "Vera",
  description: "Plans a lawyer's morning WhatsApp digest and calls Lexroom research and drafting.",
  configSchema: Type.Object(
    {
      accessToken: Type.Optional(
        Type.String({ description: "Lexroom bearer token for this lawyer. Do not commit it." }),
      ),
      baseUrl: Type.Optional(Type.String({ description: "Lexroom API base URL." })),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1000, description: "Research and draft stream timeout." }),
      ),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      name: "vera_plan_digest",
      label: "Plan Vera digest",
      description:
        "Rank one lawyer's matter signals by the cost of waiting. Returns deliver:false when nothing clears the bar. Otherwise returns one ranked list and exactly two next steps: research first, then a draft that still needs confirmation. Never sends a message.",
      parameters: Type.Object(
        {
          signals: Type.Array(signalSchema),
          now: Type.Optional(
            Type.String({ description: "ISO-8601 clock. Defaults to the current time." }),
          ),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute({ signals, now }) {
        const clock = now ? new Date(now) : new Date();
        if (Number.isNaN(clock.getTime())) {
          return { ok: false, error: "now must be an ISO-8601 timestamp" };
        }
        try {
          return { ok: true, plan: planDigest(signals as DigestSignal[], clock) };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "digest planning failed",
          };
        }
      },
    }),
    tool({
      name: "vera_research",
      label: "Lexroom research",
      description:
        "Run Lexroom research for one matter. Pass libraryDocumentIds only for documents that belong to that matter. The private library is not searched unless those ids are present.",
      parameters: Type.Object(
        {
          matterId: Type.String({ minLength: 1 }),
          query: Type.String({ minLength: 1 }),
          libraryDocumentIds: Type.Optional(Type.Array(Type.String())),
          modules: Type.Optional(Type.Array(Type.String())),
          parentResearchId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config: LexroomConfig, context) {
        return await runResearch({
          config,
          matterId: params.matterId,
          query: params.query,
          libraryDocumentIds: params.libraryDocumentIds,
          modules: params.modules,
          parentResearchId: params.parentResearchId,
          signal: context.signal,
        });
      },
    }),
    tool({
      name: "vera_draft",
      label: "Lexroom draft",
      description:
        "Draft a legal act for one matter. Set confirmed true only after the lawyer agrees in the chat. Any other value returns confirmation_required and does not call Lexroom.",
      parameters: Type.Object(
        {
          matterId: Type.String({ minLength: 1 }),
          prompt: Type.String({ minLength: 1 }),
          confirmed: Type.Boolean(),
          modules: Type.Optional(Type.Array(Type.String())),
          parentResearchId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config: LexroomConfig, context) {
        return await runDraft({
          config,
          matterId: params.matterId,
          prompt: params.prompt,
          confirmed: params.confirmed,
          modules: params.modules,
          parentResearchId: params.parentResearchId,
          signal: context.signal,
        });
      },
    }),
  ],
});

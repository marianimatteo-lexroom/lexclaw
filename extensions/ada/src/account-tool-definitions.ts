import { Type } from "typebox";
import { DEADLINE_REPLY_ACTIONS } from "./deadline-tools.js";
import { MEMORY_FOLDERS } from "./memory-contract.js";

/**
 * The model-facing definitions of every tool that acts on one person's accounts or data. None
 * takes a number: they act for the person asking in the current private chat, as the host
 * reports it, and for no one else.
 */
export const adaDraftDefinition = {
  name: "ada_draft",
  label: "Lexroom draft",
  description:
    "Draft a legal act for one matter, with the Lexroom account of the person asking. Set confirmed true only after they agree in the chat. Any other value returns confirmation_required and does not call Lexroom.",
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
};

export const adaLexroomConnectDefinition = {
  name: "ada_lexroom_connect",
  label: "Connect Lexroom",
  description:
    "Check whether the person asking has connected their own Lexroom account for research and drafting, and give them the link to connect it. Ada renews the saved sign-in by herself from the saved email and password when it is expiring, then checks it with a live Lexroom call. When it is not connected, or only a wrong password, an account that needs a one-time code, or a missing saved password removed it, it returns one WhatsApp ask with a single Ada-hosted Lexroom sign-in link that connects this person's account and no one else's. A 403 or an unreachable Lexroom never removes it. Set force true to discard the saved sign-in and always get a new link. Does not send the message.",
  parameters: Type.Object(
    { force: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
};

export const adaGoogleConnectDefinition = {
  name: "ada_google_connect",
  label: "Connect Gmail and Calendar",
  description:
    "Check whether the person asking has connected their own Gmail and Google Calendar, including permission to send mail, and give them the link to connect them. When they have not, or the saved connection cannot send, return one WhatsApp ask and a single Google OAuth link that connects this person's account and no one else's. Does not send the message.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

export const adaReadInboxDefinition = {
  name: "ada_read_inbox",
  label: "Read connected Gmail",
  description:
    "Read recent inbox metadata from the Gmail account the person asking connected. Does not send mail.",
  parameters: Type.Object(
    { max: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) },
    { additionalProperties: false },
  ),
};

export const adaReadCalendarDefinition = {
  name: "ada_read_calendar",
  label: "Read connected Google Calendar",
  description:
    "Read upcoming events from the Google Calendar the person asking connected. Read-only. Never creates or moves events.",
  parameters: Type.Object(
    { hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })) },
    { additionalProperties: false },
  ),
};

export const adaSendEmailDefinition = {
  name: "ada_send_email",
  label: "Send email from connected Gmail",
  description:
    "Send one plain-text email from the Gmail account the person asking connected. Set confirmed true only after they agree in the chat to that exact message. Any other value returns confirmation_required and does not send. Calendar stays read-only.",
  parameters: Type.Object(
    {
      to: Type.String({ minLength: 3, description: "One recipient email address." }),
      subject: Type.String({ minLength: 1, description: "One-line subject." }),
      text: Type.String({ minLength: 1, description: "Plain-text body." }),
      confirmed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
};

export const adaDeadlineListDefinition = {
  name: "ada_deadline_list",
  label: "List tracked deadlines and hearings",
  description:
    "List upcoming hearings and deadlines Ada extracted from the asking person's mail and calendar, with the numbers from their last digest, status (candidate or tracked), confidence, sources, and reminder schedule. Read-only. Requires deadlineIntake.enabled.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

export const adaDeadlineReplyDefinition = {
  name: "ada_deadline_reply",
  label: "Act on a digest deadline",
  description:
    "Apply the user's reply to a numbered deadline or hearing from their digest. research confirms tracking (reminders start) and runs Lexroom research for that matter, returning the brief to text back. track confirms tracking only. brief returns the stored brief again without calling Lexroom. dismiss and done close the item. Call it only after the user replies; never to guess. Sends no email and does not touch the calendar.",
  parameters: Type.Object(
    {
      ref: Type.String({
        minLength: 1,
        description: 'The digest number the user replied with, such as "1", or a deadline id.',
      }),
      action: Type.Union(DEADLINE_REPLY_ACTIONS.map((action) => Type.Literal(action))),
    },
    { additionalProperties: false },
  ),
};

export const adaMemorySearchDefinition = {
  name: "ada_memory_search",
  label: "Search matter memory",
  description:
    "Keyword search inside one matter's Instinct-shaped wiki of the person asking. Aliases matter; misspellings do not. Never crosses matters.",
  parameters: Type.Object(
    { query: Type.String({ minLength: 1 }), matterId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
};

export const adaMemoryListDefinition = {
  name: "ada_memory_list",
  label: "List matter memory folder",
  description: "List current wiki pages in one Instinct folder for one matter.",
  parameters: Type.Object(
    {
      folder: Type.Union(MEMORY_FOLDERS.map((folder) => Type.Literal(folder))),
      matterId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
};

export const adaMemoryGetDefinition = {
  name: "ada_memory_get",
  label: "Get matter memory page",
  description: "Read one rendered wiki page. Requires the matter id that owns it.",
  parameters: Type.Object(
    { id: Type.String({ minLength: 1 }), matterId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
};

export const adaMemoryHistoryDefinition = {
  name: "ada_memory_history",
  label: "Matter memory history",
  description: "Read revision summaries for one page. Old bodies stay here after corrections.",
  parameters: Type.Object(
    { id: Type.String({ minLength: 1 }), matterId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
};

export const adaTodoListDefinition = {
  name: "ada_todo_list",
  label: "List open loops",
  description: "List todo ids, owners, titles, and statuses. Details need ada_todo_get.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

export const adaTodoGetDefinition = {
  name: "ada_todo_get",
  label: "Get open loop detail",
  description: "Read detail for one open loop.",
  parameters: Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
};

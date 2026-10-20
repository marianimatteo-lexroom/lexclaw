import { Type } from "typebox";
import { DEADLINE_REPLY_ACTIONS } from "./deadline-tools.js";
import {
  ANNOUNCEMENTS_OFF_KEY,
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_TEXT_CHARS,
  MEMORY_FOLDERS,
  PREFERENCE_LIMITS,
  QUIET_BRIEF_OFF_KEY,
} from "./memory-contract.js";

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
    "Check whether the person asking has connected their own Lexroom account for research and drafting, and give them the link to connect it. Call it when they want to connect (they said yes to your question, or asked themselves), not before asking. Ada renews the saved sign-in by herself from the saved email and password when it is expiring, then checks it with a live Lexroom call. When it is not connected, or only a wrong password, an account that needs a one-time code, or a missing saved password removed it, it returns one WhatsApp ask with a single Ada-hosted Lexroom sign-in link that connects this person's account and no one else's. A 403 or an unreachable Lexroom never removes it. Set force true to discard the saved sign-in and always get a new link. Does not send the message.",
  parameters: Type.Object(
    { force: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
};

export const adaGoogleConnectDefinition = {
  name: "ada_google_connect",
  label: "Connect Gmail and Calendar",
  description:
    "Check whether the person asking has connected their own Gmail and Google Calendar, including permission to send mail, and give them the link to connect them. Call it when they want to connect (they said yes to your question, or asked themselves), not before asking. When they have not, or the saved connection cannot send, return one WhatsApp ask and a single Google OAuth link that connects this person's account and no one else's. Does not send the message.",
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
    "Read upcoming events, with their ids and who is invited (email and name), from the Google Calendar the person asking connected. Does not change anything; use ada_create_calendar_event and ada_update_calendar_event for that.",
  parameters: Type.Object(
    { hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })) },
    { additionalProperties: false },
  ),
};

export const adaSendEmailDefinition = {
  name: "ada_send_email",
  label: "Send email from connected Gmail",
  description:
    "Send one plain-text email from the Gmail account the person asking connected. Set confirmed true only after they agree in the chat to that exact message. Any other value returns confirmation_required and does not send.",
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

const calendarEventFields = {
  timeZone: Type.Optional(
    Type.String({
      description:
        "IANA time zone of start and end. Left out, a new event uses the person's own time zone (Europe/Rome when unknown) and a moved event keeps its own.",
    }),
  ),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
};

const START_END = {
  start: "Start as an ISO 8601 date-time without offset, such as 2026-10-20T15:00:00.",
  end: "End, in the same form.",
};

export const adaCreateCalendarEventDefinition = {
  name: "ada_create_calendar_event",
  label: "Create event in connected Google Calendar",
  description:
    "Create one event on the primary Google Calendar the person asking connected. First tell them in plain words what you will create (title, day, time, time zone, location, guests) and ask if it is right. Set confirmed true only after they agree in the chat to that exact event, and only with the confirmed value true; anything else returns confirmation_required and creates nothing. Guests receive a Google invitation. Never deletes.",
  parameters: Type.Object(
    {
      title: Type.String({ minLength: 1 }),
      start: Type.String({ description: START_END.start }),
      end: Type.String({ description: START_END.end }),
      attendees: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 20,
          description: "Email addresses of the guests. Add only people the user named.",
        }),
      ),
      ...calendarEventFields,
      confirmed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
};

export const adaUpdateCalendarEventDefinition = {
  name: "ada_update_calendar_event",
  label: "Update event in connected Google Calendar",
  description:
    "Change one existing event on the primary Google Calendar the person asking connected. Get eventId, and the guests already invited, from ada_read_calendar. Send only the fields that change; start and end go together. Guests can only be added, never removed: addAttendees adds to the current list and keeps everyone already on it. First tell them in plain words what changes and who is already invited, and ask if it is right. Set confirmed true only after they agree in the chat to that exact change, and only with the confirmed value true; anything else returns confirmation_required and changes nothing. Newly added guests get a Google invitation; when only the title, time or place changes, nobody is emailed, and the result says so for you to tell the person. Never deletes.",
  parameters: Type.Object(
    {
      eventId: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1 })),
      start: Type.Optional(Type.String({ description: START_END.start })),
      end: Type.Optional(Type.String({ description: START_END.end })),
      addAttendees: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 20,
          description: "Email addresses to invite in addition to the current guests.",
        }),
      ),
      ...calendarEventFields,
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

export const adaSetTimezoneDefinition = {
  name: "ada_set_timezone",
  label: "Set my time zone",
  description:
    "Save the time zone of the person asking, so their morning brief arrives at 07:40 where they are. Call it when they say where they are, are traveling or have moved, or ask for the brief at their local time, with the IANA name of that place (for example Asia/Shanghai for China, Europe/Rome for Italy, America/New_York for New York). Without a saved zone the brief follows Europe/Rome. Returns the saved zone and when the next brief is due.",
  parameters: Type.Object(
    {
      timezone: Type.String({
        minLength: 1,
        description: "IANA time zone name, such as Asia/Shanghai.",
      }),
    },
    { additionalProperties: false },
  ),
};

export const adaSetPreferenceDefinition = {
  name: "ada_set_preference",
  label: "Save my preference",
  description: `Save a standing preference of the person asking, so you follow it from now on in every chat with them. Call it whenever they tell you, in any words, how they want you to behave: style, length, tone, formality, language, emoji, signatures, how to address them, what the morning brief should contain, what to alert them about. Use a short snake_case topic as key (signature, length, tone, language, emoji, address_form, brief_content, alerts). Look at the standing preferences already in your context: when one covers the same topic, reuse its key so the new text replaces it. Write text as one standing instruction in your own words, at most ${PREFERENCE_LIMITS.maxTextChars} characters. To stop the short morning brief on quiet days use the key ${QUIET_BRIEF_OFF_KEY}. When they do not want product news or what's-new messages from Ada, use the key ${ANNOUNCEMENTS_OFF_KEY}. Not for time zones (use ada_set_timezone) and not for complaints about the product (use ada_report_feedback). At most ${PREFERENCE_LIMITS.maxCount} are kept; past that it returns the list so you can ask which to drop. Afterwards confirm in one short natural sentence in their language.`,
  parameters: Type.Object(
    {
      key: Type.String({ minLength: 1, description: "Short snake_case topic, such as signature." }),
      text: Type.String({ minLength: 1, description: "The standing instruction, one sentence." }),
    },
    { additionalProperties: false },
  ),
};

export const adaForgetPreferenceDefinition = {
  name: "ada_forget_preference",
  label: "Forget my preference",
  description: `Remove a saved standing preference of the person asking, by its key, when they take it back or ask you to stop doing it. Returns what is still saved. For ${QUIET_BRIEF_OFF_KEY} it turns the quiet-day brief back on, and for ${ANNOUNCEMENTS_OFF_KEY} product news. Confirm in one short natural sentence in their language.`,
  parameters: Type.Object(
    { key: Type.String({ minLength: 1, description: "Key of a saved preference." }) },
    { additionalProperties: false },
  ),
};

export const adaReportFeedbackDefinition = {
  name: "ada_report_feedback",
  label: "Pass feedback to the team",
  description: `Record feedback about the product itself for the Lexroom team: a bug, a missing feature, a wrong or poor answer, or a complaint. Call it when the person reports such a problem, besides answering them. Personal preferences about how you behave go to ada_set_preference instead; one message can be both. Restate the problem plainly in at most ${FEEDBACK_MAX_TEXT_CHARS} characters, naming what they asked and what went wrong. Nothing is sent to anyone: the team reads it later. Afterwards tell the person in one short sentence, in their language, that you passed it to the team.`,
  parameters: Type.Object(
    {
      category: Type.Union(FEEDBACK_CATEGORIES.map((category) => Type.Literal(category))),
      text: Type.String({ minLength: 1, description: "The problem, restated plainly." }),
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

export const adaGranolaConnectDefinition = {
  name: "ada_granola_connect",
  label: "Connect Granola",
  description:
    "Check whether the person asking has connected their own Granola account (meeting notes and transcripts, read only), and give them the link to connect it. Call it when they want to connect (they said yes to your question, or asked themselves), not before asking. When it is not connected, it returns one WhatsApp ask with a single short Ada-hosted link that opens Granola's own sign-in for this person's account and no one else's. Set force true only to get a new link for someone who is already connected. Does not send the message.",
  parameters: Type.Object(
    { force: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
};

export const adaGranolaDisconnectDefinition = {
  name: "ada_granola_disconnect",
  label: "Disconnect Granola",
  description:
    "Disconnect the person asking from Granola: Ada asks Granola to revoke the access and deletes the saved sign-in. Call it when they say, in any words, that they want Ada to stop using or forget their Granola. Nothing in Granola itself is changed or deleted. They can connect again whenever they want.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

export const adaGranolaToolsDefinition = {
  name: "ada_granola_tools",
  label: "List Granola tools",
  description:
    "List the Granola tools this person's plan offers right now (search and list meetings, read notes and transcripts, folders, questions about meetings), with each one's real argument schema. Call it before ada_granola_call when you do not know the exact tool or arguments. Read only.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

export const adaGranolaCallDefinition = {
  name: "ada_granola_call",
  label: "Read Granola meetings",
  description:
    "Call one read-only Granola tool with the Granola account of the person asking, to answer questions about their past meetings, read a note or transcript, or pull out action items, decisions and deadlines. Tool names and arguments are Granola's own, from ada_granola_tools. The result is text of at most 14000 characters; when truncated is true, summarize it, and use offset with nextOffset only if the person needs more. A free Granola plan only reaches the last 30 days and some tools are paid only: an error then names the reason, which you explain naturally. Never changes anything in Granola.",
  parameters: Type.Object(
    {
      tool: Type.String({ minLength: 1, description: "A tool name from ada_granola_tools." }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "The tool's own arguments, as its inputSchema describes.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "Start of the next part of a long result." }),
      ),
    },
    { additionalProperties: false },
  ),
};

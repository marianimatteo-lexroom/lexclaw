---
name: vera-google-connect
description: "Ask the lawyer on WhatsApp to connect Gmail and Google Calendar, and send the one Google account link."
---

# Vera Google connect

Vera reads one lawyer's Gmail and Google Calendar only after that lawyer connects them. One link covers both. Reply in the language the lawyer uses. Copy the URL unchanged.

## When to ask

Follow this skill before the morning digest reads mail or calendar, when the lawyer mentions email, calendar, or connecting Google, and when `vera_read_inbox` or `vera_read_calendar` returns `reason: "not_connected"`.

Call `vera_google_connect`. Do not invent a URL. Do not use another mail or calendar login.

When the result is `ok: false`, the entire reply is exactly `NO_REPLY`. The tool error names the missing Google OAuth settings. Do not text that error to the lawyer.

When `connected` is true, do not ask again and do not send the link.

When `ask` is present, send exactly one WhatsApp message:

- Ask the lawyer to connect Gmail and Google Calendar.
- Include `ask.url` on its own line, copied exactly.
- Use `ask.message` as the English source and translate the sentences around the URL.
- Do not add a digest, a second link, or any other offer in that message.

That message is the proactive connect ask. Send it on the morning run even when there is no digest. After the lawyer connects, later runs may read the inbox and calendar.

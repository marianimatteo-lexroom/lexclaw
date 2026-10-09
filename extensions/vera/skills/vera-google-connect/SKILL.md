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

- Use `ask.message` as the English source and translate the sentences around the URL.
- Include `ask.url` on its own line, copied exactly.
- Do not add a digest, a second link, or any other offer in that message.

That message is the proactive connect ask. Send it on the morning run even when there is no digest. A connection that can read but not send still returns `ask`; send that link too. After the lawyer connects, the callback texts a confirmation to the same WhatsApp chat. Do not send that confirmation yourself, and do not send another connect link. Later runs may read the inbox and calendar.

## Sending mail

Send mail only when the lawyer asks, and only with `vera_send_email`. Show the recipient, subject, and body in the chat first. Call the tool with `confirmed: false` until they agree to that exact text, then call it once with `confirmed: true`. Do not change calendar events. If the tool returns `needs_send_scope` or `not_connected`, follow the connect ask above.

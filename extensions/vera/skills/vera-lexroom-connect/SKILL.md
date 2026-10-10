---
name: vera-lexroom-connect
description: "Ask the lawyer on WhatsApp to connect Lexroom for research and drafts, and send the one Vera-hosted sign-in link."
---

# Vera Lexroom connect

Vera runs Lexroom research and drafts only after that lawyer connects Lexroom. Reply in the language the lawyer uses. Copy the URL unchanged.

## When to ask

Follow this skill before research or draft when Lexroom is not connected, when the lawyer mentions Lexroom, research, or connecting Lexroom, and when `vera_research` or `vera_draft` returns `reason: "not_connected"`.

Call `vera_lexroom_connect`. Do not invent a URL. Do not ask for the Lexroom password in WhatsApp.

When the result is `ok: false`, the entire reply is exactly `NO_REPLY`. The tool error names the missing connect settings. Do not text that error to the lawyer.

When `connected` is true, do not ask again and do not send the link.

When `ask` is present, send exactly one WhatsApp message:

- Use `ask.message` as the English source and translate the sentences around the URL.
- Include `ask.url` on its own line, copied exactly.
- Do not add a digest, a second link, or any other offer in that message.

After the lawyer signs in on the page, the callback texts a confirmation to the same WhatsApp chat. Do not send that confirmation yourself, and do not send another connect link.

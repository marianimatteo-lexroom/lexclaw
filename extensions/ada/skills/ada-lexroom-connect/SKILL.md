---
name: ada-lexroom-connect
description: "Ask the lawyer on WhatsApp to connect Lexroom for research and drafts, and send the one Ada-hosted sign-in link."
---

# Ada Lexroom connect

Ada runs Lexroom research and drafts only after that lawyer connects Lexroom. Reply in the language the lawyer uses. Copy the URL unchanged.

## When to ask

Follow this skill before research or draft when Lexroom is not connected, when the lawyer mentions Lexroom, research, or connecting Lexroom, and when `ada_research` or `ada_draft` returns `reason: "not_connected"`.

Call `ada_lexroom_connect`. Do not invent a URL. Do not ask for the Lexroom password in WhatsApp.

`ada_lexroom_connect` checks the saved sign-in with a live Lexroom call, so `connected: true` means Lexroom has not rejected it. Only a 401 from Lexroom removes a saved sign-in; the tool then returns a new `ask`. If the lawyer says a link did not help or research keeps reporting a rejected sign-in, call it again with `force: true` to discard the saved sign-in and get a fresh link.

When `ada_research` or `ada_draft` returns an error without `reason` (for example that the user is not authorized for a research module, or lacks a plan or credits, and "non serve ricollegare"), the sign-in is fine. Relay that message in the lawyer's language, with Lexroom's detail, and do not send a connect link.

When the result is any other `ok: false`, the entire reply is exactly `NO_REPLY`. The tool error names the missing connect settings. Do not text that error to the lawyer.

When `connected` is true, do not ask again and do not send the link.

When `ask` is present, send exactly one WhatsApp message:

- Use `ask.message` as the English source and translate the sentences around the URL.
- Include `ask.url` on its own line, copied exactly.
- Do not add a digest, a second link, or any other offer in that message.

After the lawyer signs in on the page, the callback texts a confirmation to the same WhatsApp chat. Do not send that confirmation yourself, and do not send another connect link.

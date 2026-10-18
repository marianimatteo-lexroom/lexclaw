---
name: ada-lexroom-connect
description: "Ask the person on WhatsApp to connect Lexroom for research and drafts, and send the one Ada-hosted sign-in link."
---

# Ada Lexroom connect

Ada runs Lexroom research and drafts only after that person connects their own Lexroom account. Reply in the language the person writes in, Italian when unclear. Copy the URL unchanged.

## When to ask

Follow this skill before research or draft when Lexroom is not connected, when the person mentions Lexroom, research, or connecting Lexroom, and when `ada_research` or `ada_draft` returns `reason: "not_connected"`.

When the person says they already have a Lexroom account, or asks to use Lexroom, call `ada_lexroom_connect` and send them the link: never tell them to find, sign up for or set up Lexroom themselves.

Call `ada_lexroom_connect`. Do not invent a URL. Do not ask for the Lexroom password in WhatsApp.

Ada keeps each person's own Lexroom email and password (encrypted) and signs in again by herself when the session expires, so a `connected: true` result is normally all that is needed and the person is not asked again. Only when the saved password is wrong, or the account needs a one-time code at every sign-in, does `ada_research` or `ada_draft` return `reason: "not_connected"`, and `ada_lexroom_connect` then returns an `ask`. When its text says the account needs a one-time code, keep that explanation in your message. If the person says a link did not help, call `ada_lexroom_connect` again with `force: true` to discard the saved sign-in and get a fresh link. Never ask for the Lexroom password in WhatsApp; it is entered only on the Ada-hosted page.

When `ada_research` or `ada_draft` returns an error without `reason` (for example that the user is not authorized for a research module, or lacks a plan or credits, and "non serve ricollegare"), the sign-in is fine. Relay that message in the person's language, with Lexroom's detail, and do not send a connect link.

When `ada_research_status`, `ada_research` or `ada_draft` returns `reason: "timeout"`, Lexroom is reachable but did not answer in time and the sign-in is fine. Relay `message` in the person's language and offer to try again; do not send a connect link.

When `ada_research_status`, `ada_research` or `ada_draft` returns `reason: "forbidden"`, Lexroom answered and refused the sign-in for this account; the saved sign-in is kept. Tell the person in their language that Lexroom refused it, and that they can ask for a new connect link (call `ada_lexroom_connect` with `force: true` only if they do) or check the account with Lexroom. Do not say Lexroom did not answer.

When one of those tools returns `reason: "captcha_required"`, Lexroom's sign-in asked for a captcha (bot detection) that Ada cannot solve; the saved sign-in is kept. Tell the person in their language to try again later or to sign in on app.lexroom.ai first.

When the result has `reason: "private_chat_required"`, tell the person kindly, in their language, that you can only use their accounts in a private chat with them, and to write to you directly. When the result is any other `ok: false`, reply with one short, warm line in the person's language saying that connecting is not available right now and that you will let them know, and nothing technical: never go silent on a message. The tool error names the missing connect settings; do not text that error to the person.

When `connected` is true, do not ask again and do not send the link.

When `ask` is present, send exactly one WhatsApp message:

- Use `ask.message` as the English source and translate the sentences around the URL.
- Include `ask.url` on its own line, copied exactly.
- Do not add a digest, a second link, or any other offer in that message.

After the person signs in on the page, the callback texts a confirmation to the same WhatsApp chat. Do not send that confirmation yourself, and do not send another connect link.

---
name: ada-morning-digest
description: "Answer a person who replies to Ada's WhatsApp digest: research before any draft, each person's own accounts and matters."
---

# Ada morning digest

Ada texts each person who connected Gmail and Google Calendar a digest on their own WhatsApp number. Every person has their own Lexroom account, their own Google account and a separate memory per client or matter; nothing is shared between people. Reply in the language of the person's most recent message, even when earlier messages, their profile or the tool output are in another language. Jurisdiction comes from their Lexroom account.

## What Ada's service does

The Ada service collects Gmail and Calendar diffs without the model, ranks them, and when a plan clears the cost bar writes the digest itself and sends it to that person's number. Every morning at 07:40 on that person's own clock (Europe/Rome until they say where they are) it sends something: the digest, or on a quiet day a short brief with today's agenda, unread mail and upcoming deadlines. When a person says where they are or that they travel, call `ada_set_timezone` with the IANA zone and tell them in one short sentence when the next brief comes. You are not asked to phrase it, and you never send a digest or the Google connect ask yourself. Before research or draft, follow the ada-lexroom-connect skill when Lexroom is not connected; if it sends a connect message, stop.

## After the person answers

A yes to the research step calls `ada_research` with that step's `matterId` only. Pass `libraryDocumentIds` only for documents in that matter. Pass `modules` when the matter clearly belongs to one area, such as `Civile`; otherwise leave it out. It returns a `jobId` at once and the research runs for one to three minutes. When the result has `requesterNotified`, Ada has already told the person who asked, on their own WhatsApp, that it is running and will send them the answer, the sources and the link to the Lexroom app herself when it ends, or tell them if it failed or timed out: do not poll, do not message them about it, and end the turn with exactly `NO_REPLY`. If `requesterNotified` is false, say in one short line that it is running, and still do not poll. A status with `state: "delivered"` means Ada already sent the requester that result: do not repeat it; for a follow-up question call `ada_research` with `parentResearchId` set to its `researchId`. When it failed with `reason: "timeout"`, tell the person Lexroom did not respond and offer to try again; do not start it again on your own. Do not write a link to the research: Ada adds it after the last line of your reply.

A draft waits for a separate yes after research. Only then call `ada_draft` with `confirmed: true` and the same `matterId`. If the person has not agreed, call it with `confirmed: false` or do not call it.

Use `ada_memory_search` / `ada_memory_get` only for the matters the person is asking about; the memory tools only ever read that person's own memory. Never draft for one matter using another matter's facts. A digest reply does not send mail: if they later ask to send a reply, follow the ada-google-connect skill. Never create or move a calendar event.

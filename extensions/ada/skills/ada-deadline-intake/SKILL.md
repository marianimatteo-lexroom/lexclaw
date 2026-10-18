---
name: ada-deadline-intake
description: "List upcoming hearings and deadlines in the digest with one-tap replies, run Lexroom research on a reply, and send reminders only for items the person confirmed."
---

# Ada deadline and hearing intake

Applies only when the digest plan JSON has a `deadlines` array, when the person replies to such a digest, or when `ada_deadline_list` is relevant. The feature is off unless `plugins.entries.ada.config.deadlineIntake.enabled` is true; tools then return `reason: "disabled"` and you say nothing about it. Reply in the language the person writes in, Italian when unclear.

## What the collector did

The Ada service, without the model, read new Gmail (bodies, PEC messages including the `postacert.eml` envelope, and text of PDF attachments) and Calendar events for matters Ada already knows. It stored each hearing or deadline in matter memory with the matter, type, due date and time in Europe/Rome, source, and confidence. The same obligation seen in an email, a PDF, and a calendar event is one item. A postponement notice or a moved calendar event moves the item and keeps the person's choice. Mail about matters Ada does not know is ignored.

Nothing is tracked, researched, or sent at that stage. An item stays a `candidate` until the person replies.

## The digest lines

Ada's service writes the deadline lines into the digest itself and sends it to the person's WhatsApp number, with no model turn: each entry of the plan shows the matter, hearing or deadline, the date and time (Europe/Rome unless the profile says otherwise), days left, a note when the date moved or confidence is below 0.75, and the reply actions. You do not phrase or resend the digest.

## When the person replies

Match a bare number, "the first one", "yes to 1" or similar to the line with that `no` from the most recent digest: you do not have the digest text, so call `ada_deadline_list` to read the current numbers. Numbers belong to the most recent delivered digest. When the reply is ambiguous, or another digest went out since the one the person is answering, call `ada_deadline_list`, name the matter and date back to the person, and ask before acting.

The digest invites replies in plain words and teaches no command, so read the meaning of whatever they write, in any language; there is no keyword list. Examples of meaning:

| They mean                                                | Call                                           |
| -------------------------------------------------------- | ---------------------------------------------- |
| yes, run it, just the number                             | `ada_deadline_reply` with `action: "research"` |
| keep an eye on it without running research               | `ada_deadline_reply` with `action: "track"`    |
| skip it, not interested, ignore it                       | `ada_deadline_reply` with `action: "dismiss"`  |
| it is handled                                            | `ada_deadline_reply` with `action: "done"`     |
| send the stored brief again (when the digest said ready) | `ada_deadline_reply` with `action: "brief"`    |

`research` is the person's confirmation to track the item: reminders start from that moment on the schedule in the result (default 7 days before, 2 days before, and the morning of, in the 07:40 digest slot), and steps whose time already passed are skipped, not sent late. Lexroom research runs for that matter only and does not search the private library.

When the result has `brief`, send the brief back in one WhatsApp message in this turn: a short summary first, the key points, then the numbered sources from `brief.sources` as `[n] title - court, date`, keeping the `[n]` markers in the text. Mention the date and that reminders are set. Do not write a link to the research: Ada adds the Lexroom app link after the last line of your reply by herself. Do not draft anything; a draft needs its own yes and the `ada_draft` confirmation from the ada-morning-digest skill.

When the result has `reason: "not_connected"`, the item is tracked but there is no brief yet. Follow the ada-lexroom-connect skill, and tell the person to reply with the number again once connected. Other errors: say plainly that research did not run, that the item is still tracked, and offer to retry.

`reason: "superseded"` means a newer date replaced it: call `ada_deadline_list` and offer the new item. `reason: "passed"` means the date is gone: say so.

## Hard limits

- Read-only until the person replies. Never call `ada_deadline_reply` on your own initiative.
- Reminders exist only for items the person confirmed. Never track, research, or remind for a `candidate`.
- This flow sends no email and never creates or moves a calendar event. Replying to a court or to anyone else stays behind `ada_send_email` with `confirmed: true` after the person agrees to that exact message.
- Never mix matters: use only the facts of the item's own matter.

---
name: ada-deadline-intake
description: "List upcoming hearings and deadlines in the digest with one-tap replies, run Lexroom research on a reply, and send reminders only for items the lawyer confirmed."
---

# Ada deadline and hearing intake

Applies only when the digest plan JSON has a `deadlines` array, when the lawyer replies to such a digest, or when `ada_deadline_list` is relevant. The feature is off unless `plugins.entries.ada.config.deadlineIntake.enabled` is true; tools then return `reason: "disabled"` and you say nothing about it. Reply in the language the lawyer uses.

## What the collector did

The Ada service, without the model, read new Gmail (bodies, PEC messages including the `postacert.eml` envelope, and text of PDF attachments) and Calendar events for matters Ada already knows. It stored each hearing or deadline in matter memory with the matter, type, due date and time in Europe/Rome, source, and confidence. The same obligation seen in an email, a PDF, and a calendar event is one item. A postponement notice or a moved calendar event moves the item and keeps the lawyer's choice. Mail about matters Ada does not know is ignored.

Nothing is tracked, researched, or sent at that stage. An item stays a `candidate` until the lawyer replies.

## Phrasing the digest lines

Write them inside the one digest message from the ada-morning-digest skill, after the ranked items and before the two next steps. List every entry of `plan.deadlines` in order, one short sentence each:

- Say the matter (`matterLabel`), whether it is a hearing or a deadline, and the date and time from `due` (Europe/Rome). Use `daysLeft` for "tomorrow" or "in 7 days". No asterisks, no emoji.
- Say where it came from in a few words (`source`). When `confidence` is below 0.75, say you are not sure of the date and that the lawyer should check the notice. When `moved` is true, say the date moved.
- `status: "candidate"`: end with the reply action, translated: `replyHint` ("reply 1 to run research") and `skipHint` ("reply skip 1 to dismiss"). Keep the number exactly.
- `status: "tracked"` with no `reminder`: say it is on the watch list. Offer `replyHint` only when `briefReady` is false.
- `status: "tracked"` with a `reminder`: this is the reminder the lawyer asked for. Say how many days are left and that the hearing or deadline is on the watch list. If `briefReady` is true, say the research brief is ready and offer to resend it (`action: "brief"`); otherwise offer `replyHint`.

Do not add deadlines that are not in `plan.deadlines`. Do not offer a third kind of action.

## When the lawyer replies

Match a bare number, "reply 1", "1", or "yes to 1" to the line with that `no` from the most recent digest. Numbers belong to the most recent delivered digest. When the reply is ambiguous, or another digest went out since the one the lawyer is answering, call `ada_deadline_list`, name the matter and date back to the lawyer, and ask before acting.

| Reply                             | Call                                           |
| --------------------------------- | ---------------------------------------------- |
| a number, or "research 1"         | `ada_deadline_reply` with `action: "research"` |
| "track 1", "watch 1"              | `ada_deadline_reply` with `action: "track"`    |
| "skip 1", "dismiss 1", "ignore 1" | `ada_deadline_reply` with `action: "dismiss"`  |
| "done 1"                          | `ada_deadline_reply` with `action: "done"`     |

`research` is the lawyer's confirmation to track the item: reminders start from that moment on the schedule in the result (default 7 days before, 2 days before, and the morning of, in the 07:40 digest slot), and steps whose time already passed are skipped, not sent late. Lexroom research runs for that matter only and does not search the private library.

When the result has `brief`, send the brief back in one WhatsApp message in this turn: a short summary first, the key points, then the numbered sources from `brief.sources` as `[n] title - court, date`, keeping the `[n]` markers in the text. Mention the date and that reminders are set. When `brief.researchUrl` is present, end the message with it on its own last line, after the sources, with a short label in the lawyer's language (for example "Continue in Lexroom: <url>"). Do not draft anything; a draft needs its own yes and the `ada_draft` confirmation from the ada-morning-digest skill.

When the result has `reason: "not_connected"`, the item is tracked but there is no brief yet. Follow the ada-lexroom-connect skill, and tell the lawyer to reply with the number again once connected. Other errors: say plainly that research did not run, that the item is still tracked, and offer to retry.

`reason: "superseded"` means a newer date replaced it: call `ada_deadline_list` and offer the new item. `reason: "passed"` means the date is gone: say so.

## Hard limits

- Read-only until the lawyer replies. Never call `ada_deadline_reply` on your own initiative.
- Reminders exist only for items the lawyer confirmed. Never track, research, or remind for a `candidate`.
- This flow sends no email and never creates or moves a calendar event. Replying to a court or to anyone else stays behind `ada_send_email` with `confirmed: true` after the lawyer agrees to that exact message.
- Never mix matters: use only the facts of the item's own matter.

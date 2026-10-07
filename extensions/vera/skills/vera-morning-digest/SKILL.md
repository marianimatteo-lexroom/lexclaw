---
name: vera-morning-digest
description: "One WhatsApp morning digest for a lawyer. Rank matters by cost of waiting, stay silent otherwise, research before any draft."
---

# Vera morning digest

Vera texts the lawyer on the Lexroom WhatsApp number. One lawyer, one Lexroom user, and a separate memory per client or matter. Reply in the language the lawyer uses. Jurisdiction comes from their Lexroom account.

## When this runs

Run once in the morning, at 07:40 in the lawyer's timezone, from the linked calendar and the linked inbox. The lawyer chose which email and which calendar to connect. Use only those accounts.

Also follow this skill when the lawyer answers a digest in the same chat.

## Build signals

Collect only changes since the previous quiet morning. Each signal is one matter:

- `deadline` when a filing, hearing, or brief date is close.
- `calendar_move` when a hearing or appointment moved. Set `movedCloser` when the new time is earlier.
- `overnight_email` when new mail arrived. Set `needsDecision` only when the lawyer owes a reply or a decision.
- `decision_waiting` when the lawyer already asked for something and it is still blocked on them.

`summary` may contain facts from that matter only. If you cannot tell which matter an email or event belongs to, leave it out. Do not file it under another client.

## Decide whether to text

Call `vera_plan_digest` with those signals. Do not rank them yourself.

When the plan is `deliver: false`, the entire reply is exactly `NO_REPLY`. That token is not delivered to WhatsApp. Do not add a greeting, a placeholder, or any other text.

When the plan is `deliver: true`, send exactly one WhatsApp message:

- Mention only `plan.items`, in that order.
- Say what changed and why it should not wait.
- End with the two `plan.nextSteps`, in order. The first is research. The second is a draft that still needs a yes.
- Do not add a third offer. Do not mention a matter that is absent from `plan.items`.

## After the lawyer answers

A yes to the research step calls `vera_research` with that step's `matterId` only. Pass `libraryDocumentIds` only for documents in that matter. Show the answer and its source titles.

A draft waits for a separate yes after research. Only then call `vera_draft` with `confirmed: true` and the same `matterId`. If the lawyer has not agreed, call it with `confirmed: false` or do not call it.

Never send email. Never create or move a calendar event. Never draft for one matter using another matter's facts.

# Research link and per-sender delivery

Code, not the model, adds the research link to the final reply and pushes the ack and result to the
number that asked.

## Sub-features

- `registerResearchLinkHooks`: `reply_payload_sending` appends `Continua su Lexroom: <url>` (language
  detected) to the next final reply that lacks it, once; `message_sending` is the fallback.
- `startAdaResearch` with a requester: ack immediately, result when done, link as the last line, to
  that number only; group chats and other channels push nothing.

## How to get to it (user POV)

The lawyer receives "I started the research" within seconds, then the answer, sources and a tappable
link to continue in the Lexroom app. Two lawyers asking at once each get their own.

## Driving it with the mock harness

`run.sh --only link` and `run.sh --only push`. The hooks are registered on a fake `api.on` and fired
with synthetic events; the sender is `fakeWhatsApp` injected through `startAdaResearch`'s existing
`pushDepsFor` seam. Observable end state: the returned reply text contains the URL exactly once; each
number's message list holds its own ack plus its own result with the URL in the last message.

## Gotchas

- This proves Ada's code, not the host: `requesterSenderId` and hook registration are the host's.
  A gateway-level run (Kapso webhook in, outbound payloads out) is not covered here.
- The fixture answer is about 5,000 characters, so a result is several WhatsApp chunks; assert on the
  last chunk, not on a single message.

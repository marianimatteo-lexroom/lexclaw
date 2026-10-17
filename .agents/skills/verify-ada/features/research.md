# Research

`runResearch` asks `POST /v1/ask_me_anything` and reads the NDJSON stream to its final snapshot.

## Sub-features

- Answer text in WhatsApp format, cited sources, research id, web-app link.
- Modules: the user's modules from `GET /v1/user/modules`, falling back to the catalog on a bad reply.
- Structured failures: 401 is `not_connected`; 403 names the denial without a reconnect reason;
  500, malformed and empty replies are `ok:false`; silence is `reason: timeout`.

## How to get to it (user POV)

The lawyer asks Ada a legal question on WhatsApp; the model calls `ada_research`.

## Driving it with the mock harness

`run.sh --only research`. Per-route modes on the mock create each failure
(`--route /v1/ask_me_anything=stall`). Observable end state: the returned object (`ok`, `reason`,
`error`, `researchUrl`), the mock's request log (bearer valid, modules list), elapsed time against
the 1 s test limit (`ADA_LEXROOM_TIMEOUT_MS=1000`, set by the runner for mock checks only).

## Gotchas

- The research link exists only for `lexroom.ai` hosts, so a mock on loopback must be reached
  through the harness's fetch rewrite, not by setting `baseUrl` to the mock.
- Live: one query per run, about 80 s to several minutes, costs credits.

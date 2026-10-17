# Feature map: Ada's Lexroom integration

What a lawyer relies on, and which check proves it. Each file: what it is, how the lawyer reaches
it, how to drive it here, what end state proves it. Not drivable yet are listed with the blocker.

| Feature                                         | Check ids                          | File                                                           |
| ----------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| Connect and silent re-login                     | `login.*`, `relogin.*`             | [login-and-relogin.md](login-and-relogin.md)                   |
| Research (answer, sources, structured failures) | `research.*`                       | [research.md](research.md)                                     |
| Research as a background job                    | `job.*`                            | [research-job.md](research-job.md)                             |
| Research link and per-sender delivery           | `link.appended`, `push.per-sender` | [research-link-and-delivery.md](research-link-and-delivery.md) |

Listed, not drivable by this skill:

- **Drafting** (`ada_draft`, `/v2/ai/drafting`): the mock has no drafting endpoints; fixtures
  `lexroom-draft.ndjson` and `lexroom-draft-get.json` exist but are not served.
- **The connect page and its MFA flow** (`/ada/lexroom/connect`): needs the gateway HTTP route.
- **WhatsApp 24-hour window and held results**: needs Kapso; only a fake sender is used here.

# Research as a background job

A research takes minutes, so `ada_research` returns a job handle and `ada_research_status` reads it.

## Sub-features

- `startAdaResearch`: handle returned at once; a job is read only by the number that started it.
- `readResearchJob`: `running`, `done` (answer, sources, link), `failed` (with `reason`), `delivered`
  (Ada already sent it), `unknown_job`.
- A job ends in `failed`/`timeout` when Lexroom stalls; it never runs forever.

## How to get to it (user POV)

Invisible to the lawyer: they get an ack and later the answer. The model uses the handle only when
Ada could not push (no known sender, group chat).

## Driving it with the mock harness

`run.sh --only job`. Mock `slow` mode makes a healthy research last about 2 s so the immediate
return can be timed. Observable end state: handle in under 1.5 s, immediate read `running`, waiting
read `done` with `researchUrl`, stalled mock gives `failed`/`timeout`.

## Gotchas

- The registry is in-process; a restart loses jobs by design.
- Reading a done job marks its link ready for the reply hook, so checks that read jobs share state
  with `link.appended`; the check drains it first.

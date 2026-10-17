# Connect and silent re-login

Ada signs in to Lexroom with the lawyer's saved email and password, and signs in again by herself
when the bearer expires or Lexroom rejects it.

## Sub-features

- Sign in (`loginLexroomAccount`): legacy `POST /v1/login` answers 403 `auth0_login_required`; Ada then signs in through the web flow (app `/api/auth/login`, Auth0 identifier and password pages, callback, `/api/auth/session`). With `ADA_LEXROOM_AUTH0_CLIENT_SECRET` set it uses the password-realm `/oauth/token` instead.
- Renew an expired bearer before the first call; renew a rejected one after a 401 and retry once.
- Wrong password, MFA account (a captcha or other refusal keeps the account), or no saved password: clear the account and ask to reconnect.
- A 403 never touches the saved sign-in.

## How to get to it (user POV)

The lawyer connects once through the link from `ada_lexroom_connect`. After that every
`ada_research` call resolves the saved account and renews it as needed; the lawyer sees nothing.

## Driving it with the mock harness

`run.sh --only login` and `run.sh --only relogin`. Seed an account with a bearer the mock never
issued (`staleToken`) or an expired one (`expiredToken`) in a real SQLite store, then call
`executeAdaResearch`. Observable end state: research ok, one web sign-in on the mock (one `/api/auth/session` read),
asks seen as `unknown` then `valid` bearer, the saved account holds the newly issued bearer and
keeps the password. Failure modes via `--route /u/login/password=wrong_password|captcha|blocked|mfa|500|stall`, `/api/auth/session=no_token`, `/oauth/token=...`.

## Gotchas

- MFA is remembered per email for five minutes; each edge case therefore uses its own email.
- Each web-flow failure case also uses its own email; the mock keys sign-ins by a per-flow id, not by email.
- The live step signs in once with the real account; it does not exercise renewal.

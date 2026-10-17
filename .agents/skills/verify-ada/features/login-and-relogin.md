# Connect and silent re-login

Ada signs in to Lexroom with the lawyer's saved email and password, and signs in again by herself
when the bearer expires or Lexroom rejects it.

## Sub-features

- Sign in (`loginLexroomAccount`): one `POST /v1/login`, `X-Client-Type: app_lex`.
- Renew an expired bearer before the first call; renew a rejected one after a 401 and retry once.
- Wrong password, MFA account, or no saved password: clear the account and ask to reconnect.
- A 403 never touches the saved sign-in.

## How to get to it (user POV)

The lawyer connects once through the link from `ada_lexroom_connect`. After that every
`ada_research` call resolves the saved account and renews it as needed; the lawyer sees nothing.

## Driving it with the mock harness

`run.sh --only login` and `run.sh --only relogin`. Seed an account with a bearer the mock never
issued (`staleToken`) or an expired one (`expiredToken`) in a real SQLite store, then call
`executeAdaResearch`. Observable end state: research ok, exactly one `POST /v1/login` on the mock,
asks seen as `unknown` then `valid` bearer, the saved account holds the newly issued bearer and
keeps the password. Failure modes via `--route /v1/login=401|mfa|500|stall`.

## Gotchas

- MFA is remembered per email for five minutes; each edge case therefore uses its own email.
- The live step signs in once with the real account; it does not exercise renewal.

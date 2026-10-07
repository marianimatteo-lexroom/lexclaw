# Vera

Vera is the morning WhatsApp digest for one Lexroom lawyer.

At 07:40 it looks at the inbox and calendar that lawyer chose to link. It sends one message, ranked by the cost of waiting, or it stays silent. The message offers two next steps: Lexroom research first, then a Lexroom draft only after the lawyer confirms.

Each chat is one Lexroom user. Memory stays on one client or matter at a time. Research does not search the private library unless the call names that matter's document ids.

## Enable

```json5
{
  plugins: {
    entries: {
      vera: {
        enabled: true,
        config: {
          accessToken: "${LEXROOM_ACCESS_TOKEN}",
        },
      },
    },
  },
  tools: {
    alsoAllow: ["vera_plan_digest", "vera_research", "vera_draft"],
  },
}
```

Research and drafting need a bearer token from `POST /v1/login` on `https://api.lexroom.ai`, sent with `X-Client-Type: app_lex`. Machine API keys are not accepted by those endpoints yet. Keep the token out of git. If the account uses MFA, finish that sign-in before saving the token.

## Morning automation

The Gateway WhatsApp account is the Lexroom business number. `--to` is the lawyer's own number.

```bash
openclaw automations create "40 7 * * *" \
  "Run the vera-morning-digest skill now." \
  --name "Vera morning digest" \
  --tz "Europe/Rome" \
  --exact \
  --session isolated \
  --announce \
  --channel whatsapp \
  --to "+390000000000"
```

Change the timezone and the destination number. The skill sends nothing when no signal clears the bar.

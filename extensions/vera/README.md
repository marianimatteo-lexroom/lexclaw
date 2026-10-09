# Vera

Vera is the morning WhatsApp digest for one Lexroom lawyer.

At 07:40 it looks at the Gmail inbox and Google Calendar that lawyer connected. If they are not connected yet, that same run asks on WhatsApp and sends one Google link for both. After they are connected, it sends one digest, ranked by the cost of waiting, or it stays silent. The digest offers two next steps: Lexroom research first, then a Lexroom draft only after the lawyer confirms.

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
          googleClientId: "${VERA_GOOGLE_CLIENT_ID}",
          googleClientSecret: "${VERA_GOOGLE_CLIENT_SECRET}",
          googleRedirectUri: "https://gateway.example/vera/google/callback",
          googleStateSecret: "${VERA_GOOGLE_STATE_SECRET}",
        },
      },
    },
  },
  tools: {
    alsoAllow: [
      "vera_plan_digest",
      "vera_research",
      "vera_draft",
      "vera_google_connect",
      "vera_read_inbox",
      "vera_read_calendar",
      "vera_send_email",
    ],
  },
}
```

Research and drafting need a bearer token from `POST /v1/login` on `https://api.lexroom.ai`, sent with `X-Client-Type: app_lex`. Machine API keys are not accepted by those endpoints yet. Keep the token out of git. If the account uses MFA, finish that sign-in before saving the token.

## Google account

Vera uses the Gmail and Google Calendar APIs, not an MCP server and not `gog`. The morning run has no WhatsApp sender, so a requester-scoped MCP connection is not available then. `gog` login is a shell flow and its callback URL must not be texted.

Create a Google Cloud OAuth web client, enable the Gmail API and the Google Calendar API, and register `googleRedirectUri` as an authorized redirect URI. The path is `/vera/google/callback` on the public Gateway origin. `googleStateSecret` is any private string of at least 16 characters. Vera stores the refresh token in its own SQLite file under the Gateway state directory.

The connect link asks for read-only Gmail, permission to send mail, and read-only Calendar, plus the account email. Vera does not change calendar events. One link covers all of that. It expires after 30 minutes and works once. The morning skill sends it on WhatsApp until the lawyer connects, and again when an older connection cannot send mail. `vera_send_email` sends one plain-text message only after `confirmed` is true. When the link succeeds, Vera texts `channels["kapso-whatsapp"].defaultTo` that Gmail and Google Calendar are connected.

## Morning automation

The Gateway WhatsApp account is the Lexroom business number, on the Kapso channel. `--to` is the lawyer's own number.

```bash
openclaw automations create "40 7 * * *" \
  "Run the vera-morning-digest skill now." \
  --name "Vera morning digest" \
  --tz "Europe/Rome" \
  --exact \
  --session isolated \
  --announce \
  --channel kapso-whatsapp \
  --to "+390000000000"
```

Change the timezone and the destination number. The skill sends nothing when no signal clears the bar.

# Private family calendar assistant

This Cloudflare Worker is a private Spanish Telegram assistant for exactly two
allowlisted family members. It reads one explicitly configured Google Calendar
and prepares every write for a sender-owned confirmation. It never uses the
Google primary calendar fallback.

## Module map

The Worker keeps transport, integrations, and deterministic rules separate:

- `src/index.ts` validates routes and Telegram webhook input.
- `src/config` validates secrets and configuration without returning values.
- `src/features/telegram` handles Spanish commands, messages, and opaque
  callback IDs through grammY.
- `src/features/ai` calls the Gemini API with structured JSON output, then
  validates returned data with Zod. The model cannot
  access calendar tools or IDs.
- `src/shared/scheduling` applies Madrid dates, weekday checks, DST rejection,
  defaults, and exact 60-minute proximity classification.
- `src/features/calendar` uses native `fetch` with a 10-second timeout against
  only `GOOGLE_CALENDAR_ID`; `src/features/auth` encrypts the Google refresh
  token with AES-GCM before D1 persistence.
- `migrations` contains D1 state for OAuth, drafts, callback actions, and
  Telegram duplicate protection.

## Local development

Local development uses ignored `.dev.vars`. Tests mock Telegram, Google, and
Gemini, so they do not write to a real calendar or call real APIs. Copy the
placeholder file and fill it locally; do not commit real values.

```sh
cp .dev.vars.example .dev.vars
pnpm install
pnpm db:migrate:local
pnpm dev
```

`scripts/env.mjs` parses `.dev.vars` as `KEY=VALUE` text without evaluating it,
then lets explicit process environment variables override file values. Do not
source `.dev.vars` in a shell.

### Configuration reference

Set every name below. Defaults apply only where shown; all other values are
required. `WORKER_BASE_URL` must be a valid absolute URL.

| Name | Kind | Default or required value |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | secret | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | secret | at least 16 random characters |
| `GEMINI_API_KEY` | secret | Gemini API key |
| `GOOGLE_CLIENT_ID` | secret | Google OAuth web-client ID |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth web-client secret |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | secret | base64 encoding of exactly 32 bytes |
| `OAUTH_SETUP_ADMIN_TOKEN` | secret | random admin bearer token |
| `ALLOWED_TELEGRAM_USERS_JSON` | secret | exactly two numeric IDs mapped to `Jorge` and `Ana` |
| `GOOGLE_CALENDAR_ID` | configuration | dedicated `Familia` calendar ID, never `primary` |
| `WORKER_BASE_URL` | configuration | deployed Worker origin |
| `DEFAULT_TIME_ZONE` | configuration | `Europe/Madrid` only |
| `GEMINI_MODEL` | configuration | `gemini-2.5-flash-lite` |
| `DEFAULT_EVENT_DURATION_MINUTES` | configuration | `60`; integer from 5 through 1440 |

Store all eight secret values with Wrangler secrets, including the user allowlist.
Do not place real Telegram IDs in committed configuration or documentation.
Generate an exactly 32-byte key locally; never commit, log, or reuse it.

```sh
# For manually placing in ignored .dev.vars only.
openssl rand -base64 32
# Sends a newly generated value directly to Wrangler stdin.
openssl rand -base64 32 | pnpm exec wrangler secret put GOOGLE_TOKEN_ENCRYPTION_KEY
```

After initial deployment, run this interactive command for every remaining
secret. `wrangler secret put` creates a new deployed Worker version.

```sh
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put OAUTH_SETUP_ADMIN_TOKEN
pnpm exec wrangler secret put ALLOWED_TELEGRAM_USERS_JSON
```

`ALLOWED_TELEGRAM_USERS_JSON` must have this shape, replacing examples with
real sender IDs:

```json
{"123456789":"Alex","987654321":"Sam"}
```

Use numeric Telegram user IDs, not display names or usernames. Alex and Sam
must each start a private chat with the bot before sending requests. Discover
IDs only from controlled private update metadata; never log full messages,
request bodies, tokens, or OAuth callback URLs.

### Telegram identity bootstrap

Discover both IDs before `webhook:set`. The script reads at most 20 pending
private `message` updates without acknowledging them, then prints only
deduplicated numeric IDs locally.

1. Set `TELEGRAM_BOT_TOKEN` only in ignored `.dev.vars` or an explicit process
   environment variable. Don't copy a Telegram Bot API URL or token into a
   command.
2. With no webhook configured, have Alex and Sam each start a private chat
   with the bot and send `/start`.
3. Run `pnpm telegram:ids`.
4. Manually map the two printed IDs to `Jorge` and `Ana`, then set the JSON with
   the existing interactive command:

   ```sh
   pnpm exec wrangler secret put ALLOWED_TELEGRAM_USERS_JSON
   ```

The script checks `getWebhookInfo` first. If a webhook exists, it stops before
reading updates and never changes or deletes that webhook. Keep the webhook
configured and use Telegram Desktop's personal data export instead. Set the
allowlist before full Worker deployment; setting that secret does not configure
a webhook.

## D1 setup and migrations

Create D1 manually. The all-zero `database_id` in `wrangler.jsonc` is an
intentional placeholder and not a usable deployment configuration:

```sh
pnpm exec wrangler d1 create telegram-family-bot
# Manually replace only wrangler.jsonc d1_databases[0].database_id with output.
pnpm cf-typegen
```

After changing a D1 binding or ID, run `pnpm cf-typegen` to regenerate
`worker-configuration.d.ts`. Keep Worker name `telegram-family-bot` and
compatibility date `2026-10-06` unchanged.

Run migrations in numeric order. Wrangler tracks applied files; do not execute
these SQL files by hand or skip a number.

| Migration | Schema effect |
| --- | --- |
| `0001_private_family_calendar.sql` | OAuth states, encrypted credential, conversations, pending actions, processed updates, and an action index |
| `0002_recovery_leases.sql` | leases for in-progress webhook updates |
| `0003_action_fencing.sql` | fencing tokens for actions and webhook updates |

Use these package scripts against the configured `DB` binding:

```sh
pnpm db:migrate:local
pnpm db:migrate:remote
```

`db:migrate:local` changes local Wrangler state. `db:migrate:remote` changes
configured remote D1, so first confirm the real ID and account. Neither runs in
tests or in this documentation unit.

## Google Calendar OAuth

Use a dedicated Google Calendar named `Familia`, and set its ID in
`GOOGLE_CALENDAR_ID`. The Google account completing consent must be an editor
with `writer` or `owner` access. During code exchange, the Worker verifies that
access against this exact calendar before storing an encrypted refresh token.

Register this exact redirect URI in the Google OAuth web-client configuration.
It must match `WORKER_BASE_URL` after the Worker removes one trailing slash:

```text
https://your-worker.workers.dev/auth/google/callback
```

The browser flow requests offline access and exactly these scopes:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

Start it with an administrator bearer token in a header, never in a URL. The
endpoint returns a `302` redirect whose `Location` is the Google authorization
URL. This command prints that URL, but not its bearer token; open it in a
browser to complete Google's flow.

```sh
read -rs 'OAUTH_SETUP_ADMIN_TOKEN?Admin token: '; printf '\n'
curl --silent --show-error --output /dev/null --write-out '%{redirect_url}\n' \
  --request POST \
  --header "Authorization: Bearer $OAUTH_SETUP_ADMIN_TOKEN" \
  'https://your-worker.workers.dev/admin/oauth/start'
unset OAUTH_SETUP_ADMIN_TOKEN
```

The Worker refreshes access tokens automatically; never paste refresh tokens
into chat, URLs, or configuration. If a token is revoked, malformed, or cannot
refresh, repeat the admin flow. If authorization says the calendar is unavailable
or not writable, correct the exact `Familia` ID or grant `writer` or `owner`
access, then reconnect.

For an external OAuth app in **Testing**, configured test users are required and
these Calendar scopes cause refresh tokens to expire after seven days. Published
but unverified external apps can show warnings and are not a safe long-term
personal-use assumption. Review current [OAuth consent-screen guidance](https://developers.google.com/calendar/api/guides/auth),
[production-readiness guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview),
and [verification requirements](https://support.google.com/cloud/answer/13464321)
before selecting publication or verification status.

## Telegram webhook

Deploy only after local validation, then configure the webhook from ignored
local variables or explicit process environment. Scripts fail closed when
required values are absent and never print the bot token or webhook URL.

```sh
pnpm webhook:set
pnpm webhook:info
```

`webhook:set` registers `POST /webhooks/telegram`, the configured secret token,
and only `message` and `callback_query` updates. `webhook:info` prints only
whether a webhook is configured and its pending update count. Telegram calls
must include the secret-token header. The Worker validates bounded JSON, accepts
private-chat allowlisted users only, and retains update state until processing
completes. Repeated updates and double callback clicks cannot create an extra
event.

## Runtime behavior and status

Commands and Telegram replies are Spanish; setup artifacts are English.
`/start`, `/help`, `/today`, `/tomorrow`, `/week`, `/cancel`, and `/status` are
deterministic and do not call AI. A complete request such as
`dentista sábado 10 de octubre a las 18` prepares a 60-minute event, names it
for the sender, and shows a confirmation button.

Every create operation uses a deterministic Google event ID and an action
marker. Network uncertainty reconciles by ID rather than repeating a mutation.
Event callbacks are opaque, sender-owned, private-chat-only, expiring, and
atomically claimed. Existing all-day, cancelled, and transparent events are
handled separately. Recurring-series writes are intentionally refused.

Before a confirmed create, the Worker reads the proposed interval plus 60
minutes on both sides and labels overlap, exactly 60-minute before/after
proximity, or clear. It never moves an event automatically. Updates and
deletions must use an exact, selected event and etag preconditions.

`/status` works only for an allowlisted private-chat sender. It reports
`Calendario conectado.` only when an encrypted credential exists in D1. It does
not refresh a token, call Google, or re-check current calendar permissions. Use
the OAuth connection flow to validate `writer` or `owner` access before writes.

## Testing and validation

External services are mocked in tests, including clock and DST cases. Run these
checks before deployment:

```sh
pnpm format
pnpm typecheck
pnpm lint:ci
pnpm test
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false pnpm exec wrangler deploy --dry-run
```

### Package scripts

Use these existing scripts; `lint` and `lint:ci` are read-only, while `format`
rewrites only its configured source and configuration paths.

| Script | Purpose |
| --- | --- |
| `pnpm dev` or `pnpm start` | run `wrangler dev` locally |
| `pnpm deploy` | deploy the Worker; run only as an authorized manual action |
| `pnpm cf-typegen` | generate Worker binding types after binding changes |
| `pnpm typecheck` | strict application and test TypeScript checks |
| `pnpm lint` or `pnpm lint:ci` | read-only Biome checks |
| `pnpm format` | write Biome formatting for configured source paths |
| `pnpm test` or `pnpm test:watch` | run mocked tests once or in watch mode |
| `pnpm db:migrate:local` | apply migrations to local Wrangler D1 state |
| `pnpm db:migrate:remote` | apply migrations to configured remote D1 |
| `pnpm telegram:ids` | print local private-chat IDs before configuring a webhook |
| `pnpm webhook:set` or `pnpm webhook:info` | register or inspect Telegram webhook safely |

For a manual smoke test, use a dedicated `TEST — ...` title and first verify
the selected calendar is `Familia`. Exercise read, create after confirmation,
update after confirmation, and delete only that same test event after
confirmation. Never bulk-delete, modify, or smoke-test real family entries. The
application has no automatic production smoke test.

`GEMINI_MODEL` defaults to `gemini-2.5-flash-lite` and remains configurable. The
implementation uses Gemini structured JSON output, not tool calls. Choose a
currently supported model that supports this mode and fits cost and latency
needs. This repository states no prices or fixed traffic quotas; consult current
[Gemini structured output documentation](https://ai.google.dev/gemini-api/docs/structured-output),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Ordered go-live checklist

Complete this sequence manually. No remote action in this list occurred in this
documentation unit.

1. Create D1, replace its placeholder ID, and run `pnpm cf-typegen`.
2. With no Telegram webhook, have Alex and Sam each send `/start` in a private
   chat, then run `pnpm telegram:ids` from safe local variables.
3. Map its numeric output to `Jorge` and `Ana`, then set
   `ALLOWED_TELEGRAM_USERS_JSON` interactively.
4. Set the other seven secrets with `wrangler secret put`, and set all five
   non-secret configuration values through the Worker configuration process.
5. Confirm `GOOGLE_CALENDAR_ID` is fixed `Familia`, `GEMINI_MODEL` supports
   structured JSON output, and `WORKER_BASE_URL` is final.
6. Run `pnpm db:migrate:remote` against the confirmed D1 database.
7. Run `pnpm deploy`, then complete Google OAuth with the admin POST flow.
8. Run `pnpm webhook:set` and `pnpm webhook:info` from safe local variables.
9. Verify `/status` for both private-chat users.
10. Perform the selected-event smoke test and clean up only its temporary event.

## Security, limitations, and delivery state

No plaintext Google tokens, Telegram tokens, OAuth states, calendar IDs, or
event IDs are logged or returned to Telegram. No deployment, remote migration,
OAuth setup, or calendar mutation occurs during repository tests.

This MVP excludes recurring-series management, public/group chats, arbitrary
Telegram users, multiple Google accounts, user registration, automatic
rescheduling, and model-driven tool calls. Add them only with a new reviewed
security design. No deployed verification occurred in this session, and
independent native review remains pending.

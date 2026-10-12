# telegram-family-bot

Cloudflare Worker that runs a **private Spanish Telegram assistant** for a
shared Google Calendar. Only allowlisted private-chat senders can use it. Every
calendar write is prepared for sender-owned confirmation before it runs.

## Features

- Allowlist of 1–10 Telegram users (display names from configuration)
- Configurable IANA time zone (default `Europe/Madrid`)
- Deterministic Spanish date/time normalization plus AI interpretation
- Confirmation-only creates, updates, and deletes
- Encrypted Google refresh token in D1 (AES-GCM)
- Optional Groq → NVIDIA → Gemini interpretation chain

## Module map

- `src/index.ts` — routes, webhook auth, update recovery
- `src/config` — secrets and configuration validation
- `src/features/telegram` — grammY bot, Spanish commands and callbacks
- `src/features/ai` — structured LLM JSON + Zod validation (no calendar tools)
- `src/shared/scheduling` — local-time resolution, DST rejection, proximity
- `src/features/calendar` — Google Calendar API against a fixed calendar ID
- `src/features/auth` — OAuth + encrypted credential storage
- `migrations` — D1 schema for OAuth, drafts, actions, and update fencing

## Deploy your own

### 1. Prerequisites

- Cloudflare account with Workers + D1
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Google Cloud OAuth web client with Calendar scopes
- A dedicated Google Calendar (never use `primary` unless you accept that risk)
- At least one AI key: Gemini (required); Groq and NVIDIA optional

### 2. Clone and configure locally

```sh
cp .dev.vars.example .dev.vars
pnpm install
```

Edit `.dev.vars` with your secrets. Do not commit that file.

`ALLOWED_TELEGRAM_USERS_JSON` maps numeric Telegram user IDs to display names
(1–10 unique names):

```json
{"123456789":"Alex","987654321":"Sam"}
```

### 3. D1 database

```sh
pnpm exec wrangler d1 create telegram-family-bot
```

Either paste the returned `database_id` into a **gitignored**
`wrangler.local.jsonc` (recommended for an existing database), or omit
`database_id` in `wrangler.jsonc` and let Wrangler auto-provision on deploy.

```sh
pnpm cf-typegen
pnpm db:migrate:local
```

For production:

```sh
pnpm db:migrate:remote
# or: pnpm exec wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc
```

### 4. Secrets

Store every required secret with Wrangler (including calendar ID and Worker URL):

```sh
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_TOKEN_ENCRYPTION_KEY
pnpm exec wrangler secret put OAUTH_SETUP_ADMIN_TOKEN
pnpm exec wrangler secret put ALLOWED_TELEGRAM_USERS_JSON
pnpm exec wrangler secret put GOOGLE_CALENDAR_ID
pnpm exec wrangler secret put WORKER_BASE_URL
# optional:
pnpm exec wrangler secret put GROQ_API_KEY
pnpm exec wrangler secret put OPENAI_API_KEY
```

Generate the encryption key:

```sh
openssl rand -base64 32 | pnpm exec wrangler secret put GOOGLE_TOKEN_ENCRYPTION_KEY
```

Optional non-secret defaults in `.dev.vars` / Worker vars:

| Name | Default |
| --- | --- |
| `DEFAULT_TIME_ZONE` | `Europe/Madrid` (any valid IANA zone) |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` |
| `DEFAULT_EVENT_DURATION_MINUTES` | `60` |

### 5. Discover Telegram IDs

With **no webhook** configured, each allowlisted person sends `/start` in a
private chat, then:

```sh
pnpm telegram:ids
```

Map the printed IDs into `ALLOWED_TELEGRAM_USERS_JSON`.

### 6. Deploy, OAuth, webhook

```sh
pnpm deploy
# or: pnpm exec wrangler deploy -c wrangler.local.jsonc
pnpm oauth:start
pnpm webhook:set
pnpm webhook:info
```

Register this redirect URI on the Google OAuth client (must match
`WORKER_BASE_URL`):

```text
https://your-worker.workers.dev/auth/google/callback
```

Scopes requested:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

### 7. Smoke test

Use a dedicated `TEST — ...` event title. Verify `/status`, create after
confirmation, update after confirmation, then delete only that test event.
Never bulk-delete or modify real calendar entries during smoke tests.

## Configuration reference

| Name | Kind | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | secret | Bot API token |
| `TELEGRAM_WEBHOOK_SECRET` | secret | ≥ 16 random characters |
| `GEMINI_API_KEY` | secret | Last interpretation fallback |
| `GROQ_API_KEY` | secret, optional | Tried first when set |
| `OPENAI_API_KEY` | secret, optional | NVIDIA key for OpenAI SDK (`https://integrate.api.nvidia.com/v1`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secrets | OAuth web client |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | secret | base64 of exactly 32 bytes |
| `OAUTH_SETUP_ADMIN_TOKEN` | secret | Bearer for `POST /admin/oauth/start` |
| `ALLOWED_TELEGRAM_USERS_JSON` | secret | 1–10 numeric ID → unique display name |
| `GOOGLE_CALENDAR_ID` | secret | Dedicated calendar ID (not `primary`) |
| `WORKER_BASE_URL` | secret | Absolute Worker origin |
| `DEFAULT_TIME_ZONE` | config | Valid IANA time zone |
| `GEMINI_MODEL` | config | Must support structured JSON output |
| `DEFAULT_EVENT_DURATION_MINUTES` | config | 5–1440 |

## Privacy: what AI providers receive

Natural-language messages (and short draft context) are sent to whichever
interpretation providers you enable:

1. Groq (`GROQ_API_KEY`), if set
2. NVIDIA via the OpenAI SDK (`OPENAI_API_KEY`), if set
3. Gemini (`GEMINI_API_KEY`), always available as fallback

Providers receive the user text, sender display name, and formatted local time.
They do **not** receive calendar credentials, event IDs, or OAuth tokens. The
model cannot call calendar APIs; output is schema-validated with Zod.

Commands `/start`, `/help`, `/today`, `/tomorrow`, `/week`, `/cancel`, and
`/status` never call AI.

If you cannot send family messages to third-party LLMs, do not deploy this bot
(or keep interpretation keys unset and stick to deterministic commands only —
unstructured chat will then ask for clarification).

## Security notes

- Private chats only; non-allowlisted users are rejected
- Telegram webhook secret compared with constant-time equality
- Admin OAuth start requires `Authorization: Bearer …`
- Google refresh tokens encrypted at rest in D1
- `/health` returns only `{ "ok": true|false }` (no diagnostic field names)
- Keep the Google Calendar **private**; the calendar ID alone is not an ACL
- Optional: put Cloudflare WAF / rate limiting in front of the Worker to reduce
  quota burn from anonymous traffic

## Runtime behavior

Commands and Telegram replies are Spanish; setup docs are English.

A request such as `dentista sábado 10 de octubre a las 18` prepares a timed
event, names it for the sender (or a mentioned allowlisted member), and shows
confirmation buttons. Overlap and exact 60-minute proximity are warned, never
auto-resolved. Recurring-series writes are refused.

## Development and tests

```sh
pnpm format
pnpm typecheck
pnpm lint:ci
pnpm test
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false pnpm exec wrangler deploy --dry-run
```

Tests mock Telegram, Google, and AI providers.

### Package scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm start` | local Wrangler |
| `pnpm deploy` | deploy Worker |
| `pnpm cf-typegen` | regenerate binding types |
| `pnpm typecheck` / `pnpm lint:ci` / `pnpm test` | CI checks |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | D1 migrations |
| `pnpm telegram:ids` | discover private-chat IDs |
| `pnpm webhook:set` / `webhook:drop` / `webhook:info` | Telegram webhook helpers |
| `pnpm oauth:start` | start Google OAuth with admin bearer |

## Limitations

No group chats, public registration, multi-calendar accounts, recurring-series
management, automatic rescheduling, or model-driven tool calls. Add those only
with a fresh security design.

## License

MIT — see [LICENSE](./LICENSE).

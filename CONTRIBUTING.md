# Contributing

Thanks for helping improve this project.

## Development

```sh
cp .dev.vars.example .dev.vars
pnpm install
pnpm db:migrate:local
pnpm test
pnpm typecheck
pnpm lint:ci
```

Fill `.dev.vars` with local placeholders or test credentials. Never commit real
tokens, calendar IDs, or Worker URLs.

## Pull requests

- Keep changes focused and covered by tests where behavior changes.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, …).
- Run `pnpm format`, `pnpm typecheck`, `pnpm lint:ci`, and `pnpm test` before opening a PR.
- Do not add analytics, auth providers, or public multi-tenant features without a security review.

## Scope

Telegram replies stay in Spanish. Setup docs and code comments stay in English
unless a change intentionally adds localization.

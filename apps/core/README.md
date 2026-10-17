# Core

The central service: accounts and sign-in, worlds and their approvals, and the connect tokens that let a signed-in player into a world. Later stages add trust, the public world list, bans, mutes and blocks, reports, guardian links, uploads and conversion, the asset store, the gallery and the admin pages.

- Licence: AGPL-3.0-or-later ([LICENSE](LICENSE))
- Stack: TypeScript run directly by Node.js 24, [Fastify](https://fastify.dev/) 5, PostgreSQL through [node-postgres](https://node-postgres.com/)
- Status: Stage 1. Accounts by invitation, the age rule, sign-in through the system browser, sessions, world registration and approval, connect tokens.

## Run it on this machine

The core needs PostgreSQL's programs (`initdb`, `pg_ctl`), not a running service. This makes a private database in `~/.local/share/flatchat/core-db`, run by your own user and reachable only through a socket in that folder:

```sh
npm run core:db -- start                 # prints FLATCHAT_CORE_DB=…
npm run --silent core:admin -- secret    # prints FLATCHAT_CORE_SECRET=…
```

Put both lines in a file outside the repository, for example `~/.config/flatchat/core.env`, with the rest of the settings:

| Variable | What |
|---|---|
| `FLATCHAT_CORE_DB` | The PostgreSQL connection string (required) |
| `FLATCHAT_CORE_SECRET` | 64 hexadecimal characters; it seals the world keys, so keep it with the database's backups (required) |
| `FLATCHAT_CORE_URL` | Where people reach the core, for example `https://core.example.org` (default `http://127.0.0.1:8787`) |
| `FLATCHAT_CORE_OPERATOR` | Who runs it, shown in the privacy notice |
| `FLATCHAT_CORE_CONTACT` | How to reach them about privacy |
| `FLATCHAT_CORE_TUNNEL` | `1` when it sits behind a Cloudflare Tunnel |

Then:

```sh
node --env-file=$HOME/.config/flatchat/core.env apps/core/src/admin.ts migrate
node --env-file=$HOME/.config/flatchat/core.env apps/core/src/main.ts      # listens on 127.0.0.1:8787
```

## The admin command line

Run with the same environment: `node --env-file=FILE apps/core/src/admin.ts COMMAND`.

| Command | What it does |
|---|---|
| `secret` | Prints a new `FLATCHAT_CORE_SECRET` |
| `migrate` | Applies the database migrations (the core also does it when it starts) |
| `invite [--email E] [--note N] [--days 14]` | Prints a sign-up link, shown once. With `--email`, only that address can use it and it counts as verified |
| `invites`, `accounts` | Lists them |
| `account EMAIL [--tester on\|off] [--trust 0-7] [--status active\|suspended\|banned]` | Shows or changes an account; suspending or banning ends its sessions |
| `worlds [--status pending\|approved\|revoked]` | Lists the worlds |
| `world register --name N --owner EMAIL --address URL [--capacity 50]` | Registers a world for an account |
| `world approve ID [--note N]` | Approves it and prints `FLATCHAT_WORLD_KEY` and `FLATCHAT_WORLD_ID` for the world server's environment, once |
| `world revoke ID [--note N]`, `world events ID` | Revokes it; shows its approval record |

## How a player gets in

1. The owner sends an invitation link. The player opens it, sets an email, a password, a display name, the birth month and year and the country, and accepts the privacy notice. Accounts are for adults until the minors' protections of Stage 3 ship.
2. The client signs in through the system browser: it opens a port on 127.0.0.1, the core's sign-in page sends the browser back to that port with a one-time code, and the client trades the code (with the PKCE verifier only it knows) for a session.
3. To join a world, the client asks the core for a connect token: the account's facts sealed for that one world for 60 seconds, which the world server opens without calling the core. A world never learns a player's email or birth date.

## The API

| Method and path | Auth | What |
|---|---|---|
| `GET /api/v1/health` | — | `{ ok, version }` |
| `POST /api/v1/login-requests` | — | `{ challenge, port }` → `{ request, signinUrl, expiresAt }` |
| `POST /api/v1/sessions` | — | `{ request, code, verifier }` → `{ access, refresh, accessExpiresAt, refreshExpiresAt, account }` |
| `POST /api/v1/sessions/refresh` | — | `{ refresh }` → new tokens (a refresh token works once) |
| `POST /api/v1/sessions/revoke` | Bearer | Signs out |
| `GET /api/v1/me` | Bearer | The account: id, display name, email, verified, trust, tester, created |
| `POST /api/v1/worlds` | Bearer | `{ name, address, capacity? }` → a pending world |
| `GET /api/v1/worlds/:id` | — | Its name, status and capacity, and its address once approved |
| `POST /api/v1/worlds/:id/join` | Bearer | `{ token, address, expiresAt }` |

The pages: `/signup?invite=CODE`, `/signin?request=ID`, `/privacy`, each in English or Spanish (`?lang=es`, or the browser's language).

## Tests

`npm run test -w @flatchat/core` starts a throwaway PostgreSQL cluster in a temporary folder and gives each test file its own database; `FLATCHAT_TEST_DB` points them at one you run instead.

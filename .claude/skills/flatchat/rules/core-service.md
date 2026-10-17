---
title: The Core Service — Accounts by Invitation, the Age Rule, Browser Sign-in, Sessions, Worlds, Connect Tokens, PostgreSQL and the Admin Command Line
impact: CRITICAL
impactDescription: The core holds every account, password hash, birth date and world key. A SQL string built from input, a page that renders what someone typed as markup, a token or email in a log line, a sign-in code that can be polled for, or a test that needs a shared database each turn into an account takeover, a leak of minors' data or a flaky CI.
tags: core, apps/core, trust levels, FLATCHAT_CORE_TRUST, active_days, trustOf, earnedTrust, parseTrust, tester, Fastify, PostgreSQL, pg, node-postgres, migrations, Argon2id, crypto.argon2, PHC, invitations, sign-up, age rule, minors, OQ-16, rr-015, Decreto 1377, consent, privacy notice, sign-in, system browser, loopback redirect, RFC 8252, PKCE, RFC 7636, login request, sessions, access token, refresh token, rotation, reuse detection, rate limits, worlds, approval, world key, connect token, world browser, public list, recommended capacity, favourites, listed, unlisted, MAX_CAPACITY, admin, core:db, core:admin, T18, T19, SQL injection, escaping, content security policy
---

`apps/core` is FlatChat's central service (DR-05, AGPL-3.0-or-later): TypeScript run directly by Node.js 24, Fastify 5 for HTTP, PostgreSQL through `pg` (DR-06). Stage 1 built its spine: accounts by invitation (S1.02), the age rule and the data-processing authorization (S1.03), sign-in through the system browser with sessions (S1.04), worlds with their approval and key (S1.05) and connect tokens (S1.06).

## The Files

| File | Job |
|---|---|
| `src/main.ts` | The program: migrates, listens (127.0.0.1:8787 by default), JSON log lines `ready`, `request`, `stopped`; SIGINT, SIGTERM and `--stop-on-stdin` |
| `src/config.ts` | Settings from the environment only (`FLATCHAT_CORE_DB`, `FLATCHAT_CORE_SECRET`, `FLATCHAT_CORE_URL`, `FLATCHAT_CORE_OPERATOR`, `FLATCHAT_CORE_CONTACT`, `FLATCHAT_CORE_TUNNEL`, `FLATCHAT_CORE_TRUST`, the TURN settings) |
| `src/trust.ts` | Trust levels (S3.09): `DEFAULT_TRUST`, `parseTrust`, `earnedTrust`, `trustOf` (pure) |
| `src/mail.ts`, `src/verify.ts` | Mail (S3.03, DR-21): `Mailer` (`resendMailer` over Resend's HTTP API, `folderMailer` writing `.eml` files, `noMailer`), chosen by `FLATCHAT_CORE_MAIL`; verification links (a day, one every ten minutes, digests in `email_verifications`), `GET /verify`, `POST /api/v1/me/verify`. Never log an address or a link. `FLATCHAT_CORE_SIGNUP=open` lets `/signup` take anyone without an invitation; the tests run Resend's API as a mail catcher on loopback (`test/mail.test.ts`) |
| `src/moderation.ts` | Moderation (S3.07): platform decisions with reasons, appeals (platform and world bans), `world_unbans`, the host agreement's version; rule `roles-and-moderation` |
| `src/app.ts` | `buildCore(options)`: every route, the security headers, the rate limits, the JSON-only API; tests drive it with `app.inject` |
| `src/db.ts` | `Db` (a pool, `query`, `tx`), migrations from `src/migrations/NNNN-name.sql` under an advisory lock |
| `src/secrets.ts` | Random tokens and their SHA-256 digests, PKCE challenges, Argon2id as PHC strings, world keys sealed under the core's secret |
| `src/age.ts` | The age rule (pure) |
| `src/accounts.ts` | Fields, invitations, sign-up, the sign-in check |
| `src/sessions.ts` | Login requests, codes, sessions, refresh rotation |
| `src/worlds.ts` | Registration, approval, revocation, connect tokens |
| `src/pages.ts`, `src/strings.ts`, `src/countries.ts` | The sign-in, sign-up and privacy pages; every word in English and Spanish |
| `src/admin.ts` | The admin command line |
| `scripts/pg.ts`, `scripts/db.ts` | A private PostgreSQL cluster in a folder (no root, no port); `npm run core:db` |
| `test/` | `global-setup.ts` starts one throwaway cluster per run, `db.ts` makes a migrated database per file |

## Running It

```sh
npm run core:db -- start                        # a private cluster in ~/.local/share/flatchat/core-db; prints FLATCHAT_CORE_DB
npm run --silent core:admin -- secret           # prints FLATCHAT_CORE_SECRET=…
# put both lines (and FLATCHAT_CORE_URL, _OPERATOR, _CONTACT) in a file outside the repository, then:
node --env-file=FILE apps/core/src/admin.ts migrate
node --env-file=FILE apps/core/src/main.ts       # or: npm run core (with the variables exported)
node --env-file=FILE apps/core/src/admin.ts invite --email ana@example.org --note "first tester"
node --env-file=FILE apps/core/src/admin.ts world approve WORLD_ID   # prints FLATCHAT_WORLD_KEY and FLATCHAT_WORLD_ID once
```

## The Flows

| Flow | Rule |
|---|---|
| Invitation | The owner runs `admin invite`; the code is shown once and stored as its digest. An invitation made `--email` admits only that address and marks it verified |
| Sign-up | `/signup?invite=CODE`: email, password (10 to 256 characters, no composition rules), display name (3 to 32 letters or numbers, at most 64 UTF-8 bytes), birth month and year, country, the privacy notice's checkbox. A field mistake keeps the invitation |
| The age rule | No hint of a limit anywhere on the page. Under 13 refused everywhere; until Stage 3's protections (`policy.minors`), under 18 refused too (OQ-16); after that 13 to 17 needs a guardian, Australia stays 16 and over, Brazilian minors wait (B-20). The day is unknown, so the birthday counts as the month's last day: a doubtful case is the younger one. A refusal spends the invitation, keeps nothing about the person and sets an `HttpOnly` cookie that answers a second try the same way |
| Authorization | Every account stores its data-processing authorization (Decreto 1377, arts. 7 and 8): the notice's version, when, how (`consents`) |
| Sign-in | The client opens a loopback port, sends the S256 challenge of its verifier and the port (`POST /api/v1/login-requests`), opens `/signin?request=ID` in the system browser. After the password, the core redirects to `http://127.0.0.1:PORT/callback?request=…&code=…` (303). The client trades request, code and verifier at `POST /api/v1/sessions`: one try, 60 seconds; a wrong verifier spends the request |
| No polling | There is deliberately no endpoint that returns a request's result: a link to someone else's request would hand them the session. The code reaches only the port of the machine whose browser signed in |
| Sessions | An access token for 15 minutes (`Authorization: Bearer`), a refresh token for 30 days that rotates on every use. A refresh token seen after its rotation ends the session (`refresh-reused`). A suspended or banned account fails every check |
| Worlds | `POST /api/v1/worlds` registers one (pending). `admin world approve` makes its 32-byte key, seals it under a key derived from `FLATCHAT_CORE_SECRET` (HKDF, AES-256-GCM bound to the world's id) and prints it once. Every change goes into `world_events`, the approval record |
| Connect tokens | `POST /api/v1/worlds/:id/join` seals the account's facts for that world for 60 s (`packages/protocol`, sf-001). A world learns the account id, display name, trust, tester flag, verified email, account age in days and an under-18 flag; never the email or the birth date |
| Trust levels (S3.09, G-04) | `trustOf` = the higher of the stored level (`admin account EMAIL --trust N`, a floor; 4 to 7 only by hand) and the earned one: 0 without a verified email, else levels 1 to 3 at `FLATCHAT_CORE_TRUST`'s `days:active` thresholds (default `3:1,14:5,60:20`; each level at least the one below, else a `ConfigError`). A join is activity: `connectToken` adds one `active_days` per UTC day (`last_active_day`, migration 0004) with `returning`, and seals the token with the counted value, so the day's first join already carries it. `/api/v1/me` answers the computed level. The tester flag is apart: the closed test's door (`entry-trust`, rule `plugins`) |

## The World Browser (S2.09, Q-L4, Q-L11, Q-L19)

| Part | Rule |
|---|---|
| Live numbers | Every world with a core keeps the host channel open, relayed or not; it reports `status` (players, recommended, maximum) when they change and every 15 s, and the core keeps the last report in memory (`HostRegistry.status`). Online means the channel is open |
| Capacity | At most 200 (`MAX_CAPACITY`, Q-L19) in the API and the admin command line. The record holds what the owner approved; the world's own numbers (its `world.toml`) count only below it, and the core sends `limits` with the approved number when the world connects and after the host changes it, so the world server takes no one past it |
| The public list | `GET /api/v1/worlds`: approved, listed, online and below the recommended count, busiest first (200 at most). At the recommended count a world drops off; it is still reached by its id or a favourite up to its capacity. A world that reports itself full gets no more connect tokens (`full`, 403) |
| A world by id | `GET /api/v1/worlds/:id`: name, status, listed, online, players, recommended, capacity, and the address once approved |
| Listing | `POST /api/v1/worlds` takes `listed` (default true); the host changes it, or the capacity, with `POST /api/v1/my/worlds/:id` (its own worlds only; 404 otherwise) |
| Favourites | `GET`, `PUT` and `DELETE /api/v1/me/favourites[/:id]` (Bearer): kept with the account, so they follow it to any computer; 100 at most (`too-many`, 409); any world, whatever its status, and the list says it |
| Checked by | `test/browser.test.ts` (fake worlds on real WebSockets) and `tools/bots/src/browse.ts` (every real program: bots fill a world one at a time until it leaves the list; CI runs it in the harness job) |

## Hosting From Home (S1.13)

| Part | Rule |
|---|---|
| Relayed worlds | A world registered with the address `relay` takes players' WebRTC offers through the core: the join answers with `PUBLIC_URL/api/v1/worlds/ID/signal` as its address |
| The host channel | `GET /api/v1/worlds/:id/host` (WebSocket, subprotocol `flatchat-host-1`): the core sends `challenge` with a nonce; the world answers `auth` with `HMAC-SHA256(world key, "flatchat host v1 " + nonce)` within 5 s (else 4001; a wrong proof 4003); then `welcome`, `limits` (the approved capacity) and `ice` (its STUN and TURN servers for a day). The world sends `status` reports (the world browser). One connection per world: a newer one closes the older with 4009 (`src/hosts.ts`) |
| Signalling | `POST /api/v1/worlds/:id/signal` (Bearer) with `{ type: 'offer', sdp }` (64 KB at most): relayed as `offer` with an id, answered within 10 s, or `world-offline` (503) or `world-timeout` (504) |
| ICE servers | Every join answer carries `iceServers` (`src/ice.ts`): STUN (Cloudflare's by default; `FLATCHAT_CORE_STUN=none` turns it off), coturn credentials from `FLATCHAT_CORE_TURN_URLS` and `FLATCHAT_CORE_TURN_SECRET` (username `expiry:account-id`, credential `base64(HMAC-SHA1(secret, username))`, an hour), Cloudflare Realtime TURN from `FLATCHAT_CORE_CF_TURN_KEY` and `FLATCHAT_CORE_CF_TURN_TOKEN` (cached for 12 h). Usernames carry account ids, never emails |
| The operator's guide | `docs/hosting.md`: the tunnel, the relay, port mapping, TURN |

## Security Rules

| Rule | Why |
|---|---|
| SQL takes values only as parameters (`$1`); a template may splice in only an ALL_CAPS constant such as a column list (**T18**) | Injection; a database name in the tests is the one allowed exception, marked |
| Pages are built with `html\`…\``, which escapes every value; `raw()` takes only literal markup (**T19**) | A display name or an email is someone else's text |
| The pages' policy: `default-src 'none'; style-src 'self'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'`; no script at all | `form-action` must allow the loopback redirect after the sign-in post (Chromium checks redirects) |
| Every response: `cache-control: no-store`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, `nosniff` | URLs carry request IDs, invitation codes and sign-in codes |
| The API takes `application/json` only (415 otherwise) | A form on another site cannot post to it |
| Log lines carry method, route pattern, status and time; never a query string, a body, an email or a token | The test `never writes a token, a code, an email or a query string to its log` holds it |
| Tokens and codes are stored only as SHA-256 digests; passwords as Argon2id (64 MiB, 3 passes, 4 lanes; RFC 9106) | A copy of the database opens nothing |
| A missing account is checked against a decoy hash | Its timing does not reveal which emails exist |
| Rate limits per address, per email, per account (`src/limits.ts`) | Password guessing; five tries per email, then one a minute |
| Behind the Cloudflare Tunnel, `FLATCHAT_CORE_TUNNEL=1` trusts the forwarded address from loopback only | Rate limits must see the player, not the tunnel |

## Tests

`npm run test -w @flatchat/core` needs PostgreSQL's programs, not a running server: the global setup makes a cluster in a temporary folder (Unix socket only, fsync off) and removes it afterwards; each test file gets its own migrated database. `scripts/pg.ts` finds `initdb` and `pg_ctl` through `PG_BIN`, `pg_config`, `PATH`, or `/usr/lib/postgresql/N/bin` (GitHub's Ubuntu runners have PostgreSQL there, not on the path). `FLATCHAT_TEST_DB` points the tests at a database you run instead. Time is injected (`now`), so expiry tests move a clock instead of waiting (an access token lasts 15 minutes: a test that moves the clock a day signs in again at the new time); `TEST_COST` keeps Argon2id cheap in tests (the PHC string records each hash's cost). A Unix socket's path is limited to about 100 bytes, so clusters live in short folders without spaces.

## Correct vs. Incorrect

**Incorrect:** a lookup with the value spliced into the text.
```ts
await db.query(`select * from accounts where email_key = '${emailKey(email)}'`);
```
**Correct:** the value as a parameter; constants may be spliced.
```ts
await db.query(`select ${ACCOUNT_COLUMNS} from accounts where email_key = $1`, [emailKey(email)]);
```
**Why:** T18 fails the harness on the first; an address like `x' or '1'='1` would read every account.

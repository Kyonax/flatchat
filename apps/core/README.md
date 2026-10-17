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
| `FLATCHAT_CORE_SIGNUP` | `invite` (the default: the closed test, by invitation) or `open` (anyone, through the age rule, with the email verified by a mailed link: S3.03) |
| `FLATCHAT_CORE_MAIL` | `none` (the default), `resend` (Resend's API: `FLATCHAT_CORE_RESEND_KEY`, and `FLATCHAT_CORE_RESEND_URL` only for tests) or `folder` (each mail a `.eml` file in `FLATCHAT_CORE_MAIL_FOLDER`, for development); `FLATCHAT_CORE_MAIL_FROM` is the sender, like `FlatChat <noreply@example.org>` |
| `FLATCHAT_CORE_MINORS` | `on` lets players aged 13 to 17 sign up, each playing only once a parent or guardian authorized it (S3.04); off by default: the owner opens it at Stage 3's gate (OQ-16) |
| `FLATCHAT_CORE_TRUST` | The trust levels' thresholds: three `days:active` pairs for levels 1, 2 and 3, each asking at least as much as the one before (default `3:1,14:5,60:20`) |
| `FLATCHAT_CORE_STORE` | The file store's folder (S4.04): avatars' levels, manifests, thumbnails and the uploads they came from, each named by its SHA-256 (default `~/.local/share/flatchat/core-store`) |
| `FLATCHAT_CORE_KTX2` | `off` keeps avatars' textures as PNG: conversions take seconds instead of minutes (default on) |

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
| `account EMAIL [--tester on\|off] [--trust 0-7] [--status active\|suspended\|banned --reason R]` | Shows or changes an account; a status change needs the reason the account is shown (S3.07), and is recorded; suspending or banning ends its sessions |
| `worlds [--status pending\|approved\|revoked]` | Lists the worlds |
| `world register --name N --owner EMAIL --address URL [--capacity 50]` | Registers a world for an account (the operator's own: the host agreement counts as accepted) |
| `world approve ID [--note N]` | Approves it and prints `FLATCHAT_WORLD_KEY` and `FLATCHAT_WORLD_ID` for the world server's environment, once |
| `world revoke ID [--note N]`, `world events ID` | Revokes it; shows its approval record |
| `abuse drill` | Runs the abuse path end to end with a harmless stand-in world, account and file, sending nothing; prints the result as JSON and fails if a step did not happen (S3.12) |
| `abuse cases` | Every case: what came down and when, the 48-hour clock, each form and whether it was filed |
| `abuse export ID --out FILE` | Opens a case's sealed package for a lawful request, into a new file only you can read (never to the terminal) |
| `abuse sent ID DESTINATION --reference R`, `abuse removed ID --how H` | Records a form filed by hand on its official site; records a removal done by hand |

## How a player gets in

1. The owner sends an invitation link. The player opens it, sets an email, a password, a display name, the birth month and year and the country, and accepts the privacy notice. Accounts are for adults until the minors' protections of Stage 3 ship.
2. The client signs in through the system browser: it opens a port on 127.0.0.1, the core's sign-in page sends the browser back to that port with a one-time code, and the client trades the code (with the PKCE verifier only it knows) for a session.
3. To join a world, the client asks the core for a connect token: the account's facts sealed for that one world for 60 seconds, which the world server opens without calling the core. A world never learns a player's email or birth date.

The token carries the account's trust level (S3.09), which worlds' entry rules use. An account earns levels 1 to 3 with its age, a verified email and its active days (the days on which it joined a world, counted once a day), at the thresholds of `FLATCHAT_CORE_TRUST`; without a verified email it stays at 0. The owner may set a level by hand (`account EMAIL --trust N`): it is a floor, and levels 4 to 7 come only that way. The tester flag is apart from the levels: the closed test's door.

## Moderation (S3.07)

The owner suspends, bans or lifts accounts on the admin page (`/admin`) or with `admin account EMAIL --status … --reason R`; every decision is recorded with its reason (`moderation_actions`). A suspended or banned account cannot sign in, join a world, or (from Stage 4) upload; when its password checks, the sign-in page shows the decision and its reason, and a one-time form to appeal it. The admin page lists the appeals: reversing one lifts the decision, upholding it shows the person the answer when they sign in again. A player banned from a world appeals to that world's owner (the host tool's `appeals` and `appeal`). Every host accepts the host agreement (`/host-agreement`, English and Spanish) before a world is registered, and the admin page revokes a world with the reason its host reads (`host worlds`).

## The Guardian Link (S3.04)

With `FLATCHAT_CORE_MINORS=on`, a player aged 13 to 17 (not in Brazil, and 16 and over in Australia: the age rule) finishes its sign-up by naming a parent or guardian and agreeing to supervision. The guardian gets a link by mail (`/guardian/invite`), reads a plain summary in English or Spanish, signs in or makes an adult account with the address the teen named, and authorizes, expressly including world servers abroad; the core keeps when, how, which summary and the teen's own agreement (`guardian_links`, and a `guardian-authorization` consent). Until then the teen joins no world (`guardian-pending`). The guardian's page (`/guardian`, its own sign-in) lists the teen's friends, removes them, and chooses who may reach the teen by voice and text (friends, everyone, nobody), which the connect token carries; the teen's client always shows that supervision is on.

## Reports (S3.02)

Players report players and worlds from the client, with the chat excerpt, the world, who was near, the times and, if they keep the box ticked, the last 15 seconds of what they heard (a WAV their client cut; it leaves their computer only in a report). People without an account use the public form at `/report` (English and Spanish). Every report gets a receipt; the admin page's queue puts child sexual abuse material, grooming and threats first, and the decision goes back to the reporter (the client's home screen lists it). A report that an account is under the minimum age suspends it until the owner deletes it (age confirmed) or lifts it. Evidence is purged after about six months, a year for abuse material and grooming.

## The Abuse Path (S3.12)

A report of child sexual abuse material or of intimate images shared without consent opens a case from the admin page's queue (Abuse path). The target comes down at once: a reported world loses its approval and, if it is connected, ends every session and stops; a reported player's account is banned. The target is told a neutral reason. The core seals what it holds (the report, its chat lines and voice clip, the target's records, and from Stage 4 the uploaded files) under a key derived from `FLATCHAT_CORE_SECRET`, keeps it for a year, and opens it only through `admin abuse export`. For abuse material it drafts the reports for Te Protejo and the police's CAI Virtual (Colombia), NCMEC's CyberTipline (filed by a registered provider: the owner registers first) and, for UK-linked cases, the National Crime Agency's CEOP. Nothing is sent from the core: the owner files each draft on its official site and records the reference. Intimate images carry the 48-hour clock of the US TAKE IT DOWN Act, logged with the case. Run `admin abuse drill` after every change to this path, and once before opening sign-up. Until Microsoft's PhotoDNA accepts the platform, uploaded textures (Stage 4) are reviewed by hand.

## Avatars (S4.01, S4.04)

A player at trust level 1 (or a tester) uploads a VRM or a GLB from the client: it asks for a slot with the file's size and SHA-256, then sends the file to the slot's signed link. The core keeps the source in its file store and converts it in a separate process, one at a time: the avatar converter (`tools/converter/src/avatar-cli.ts`) under Node.js's permission model, reading only the converter's code and the upload, writing only its own folder, with no native addons, workers or child processes, 3 GB of memory and ten minutes, and in a network namespace of its own where the system allows one (the log says which at start). The converted avatar's files go to the store under their SHA-256; its manifest's names it. Anyone signed in fetches a worn avatar's files through signed links that last an hour; the client keeps them in its cache by hash. The local store serves files itself, fine on this PC, a LAN and the closed test; behind the Cloudflare Tunnel large files must not cross it (DR-16), so the R2 store (Cloudflare's free object storage, presigned links) takes over there once its bucket exists.

## The API

| Method and path | Auth | What |
|---|---|---|
| `GET /api/v1/health` | — | `{ ok, version }` |
| `POST /api/v1/login-requests` | — | `{ challenge, port }` → `{ request, signinUrl, expiresAt }` |
| `POST /api/v1/sessions` | — | `{ request, code, verifier }` → `{ access, refresh, accessExpiresAt, refreshExpiresAt, account }` |
| `POST /api/v1/sessions/refresh` | — | `{ refresh }` → new tokens (a refresh token works once) |
| `POST /api/v1/sessions/revoke` | Bearer | Signs out |
| `GET /api/v1/me` | Bearer | The account: id, display name, email, verified, trust, tester, created, and whether it is under 18 (its client keeps a minor's defaults too) |
| `POST /api/v1/worlds` | Bearer | `{ name, address, capacity?, listed?, agreement }` → a pending world; `agreement` is the host agreement's version the host accepts (1), else `agreement-required` |
| `POST /api/v1/me/verify` | Bearer | Mails a new verification link (S3.03), one every ten minutes; `GET /verify?token=…` (a page) confirms the address |
| `GET /api/v1/me/mutes`, `PUT`/`DELETE /api/v1/me/mutes/:account` | Bearer | Personal mutes (S3.08): the accounts this player does not hear, in every world |
| `GET /api/v1/me/friends`, `POST`/`DELETE /api/v1/me/friends/:account` | Bearer | Friends (S3.10): `{ friends, incoming, outgoing }`; a POST asks, or accepts the other's request; refused across a block (`friend-blocked`) and to a minor that did not ask first (`friend-minor`) |
| `GET /api/v1/me/blocks`, `PUT`/`DELETE /api/v1/me/blocks/:account` | Bearer | Blocks (S3.11): two-way, in every world; a block ends any friendship or request between the two |
| `POST /api/v1/reports` | Bearer | A report (S3.02): `{ category, target: { kind, account?, world?, ref }, text, evidence, clip? }` (the clip a base64 WAV of 700 KB at most) → `{ receipt }`; ten, then one every six minutes |
| `GET /api/v1/reports` | Bearer | The account's reports: receipt, category, status (`open`, `actioned`, `dismissed`) and the decision |
| `POST /api/v1/worlds/:id/appeals`, `GET /api/v1/worlds/:id/appeal` | Bearer | A player's appeal against that world's ban, `{ reason, text }`, and where it stands (S3.07) |
| `GET /api/v1/my/worlds/:id/appeals`, `POST /api/v1/my/worlds/:id/appeals/:appeal` | Bearer | The world's owner reads the appeals and decides one, `{ decision: reverse\|uphold, note }`; a reversal goes to the world over its host channel |
| `GET /api/v1/worlds` | — | `{ worlds: [{ id, name, capacity }] }`, the approved ones |
| `GET /api/v1/worlds/:id` | — | Its name, status and capacity, and its address once approved |
| `POST /api/v1/worlds/:id/join` | Bearer | `{ token, address, expiresAt }` |
| `POST /api/v1/avatars` | Bearer | An upload slot (S4.01): `{ name, bytes, sha256 }` → `{ id, upload: { url, method: PUT, expiresAt } }`; trust level 1 or a tester (`upload-trust`), 50 avatars, 64 MB, ten a day |
| `PUT /api/v1/avatars/:id/source?e=…&s=…` | The slot's signature | The file itself (`application/octet-stream`), exactly the size and SHA-256 the slot was asked for; then it converts |
| `GET /api/v1/avatars`, `DELETE /api/v1/avatars/:id` | Bearer | The account's avatars (status `uploading`, `converting`, `ready`, `refused` with the reasons, `failed`; rank; manifest; wearing), and deleting one |
| `PUT /api/v1/me/avatar` | Bearer | `{ avatar: id \| null }`: wear a ready avatar of the account's, or none |
| `GET /api/v1/avatar-files/:manifest` | Bearer | A worn avatar's manifest and signed links (an hour) to its manifest, levels and thumbnail (S4.04); never its source |
| `GET /api/v1/files/:hash?e=…&s=…` | The link's signature | A file of the local store; immutable (a year's cache, an `ETag`, 304 on a repeat) |

The pages: `/signup?invite=CODE`, `/signin?request=ID`, `/privacy`, each in English or Spanish (`?lang=es`, or the browser's language).

## Tests

`npm run test -w @flatchat/core` starts a throwaway PostgreSQL cluster in a temporary folder and gives each test file its own database; `FLATCHAT_TEST_DB` points them at one you run instead.

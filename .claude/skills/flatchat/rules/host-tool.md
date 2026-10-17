---
title: The Host Tool and Hosting Others — Approvals, Keys, Packaging, the Container Image, the Capacity Advisor and the World's Database
impact: HIGH
impactDescription: A host tool that keeps a key where others can read it, an admin page without CSRF protection, a package that only runs with the repository's Node.js, or a world database that forgets a persistent world's state each restart breaks hosting for everyone but the owner.
tags: host tool, tools/host-tool, flatchat-host, host signin, host request, host listing, host key, host run, host advise, --unlisted, capacity advisor, approvals, admin page, /admin, CSRF, admin_sessions, api/v1/my/worlds, api/v1/worlds/:id/key, pack.ts, tar.gz, Dockerfile, container image, persistence, WorldStore, node:sqlite, --data, reset, persistent, S2.02, S2.08, S2.10
---

`tools/host-tool` (MPL-2.0) is what a host installs: the world server, the converter and a capacity advisor behind one command (`tools/host-tool/src/cli.ts`; `npm run host --` in the repository). The core's side of hosting by others (S2.10) is its admin page and two endpoints.

## The Flow (S2.10)

| Step | Who | How |
|---|---|---|
| Sign in | the host | `host signin --core URL`: the same browser sign-in as the client (loopback port, PKCE), in Node (`src/account.ts`); the refresh token in `~/.config/flatchat/host.json` (0600), rotated on every use |
| Ask | the host | `host request --name N [--capacity 50] [--unlisted]`: `POST /api/v1/worlds` with the address `relay` (S1.13), so the world needs no TCP port; at most 200 players (Q-L19); `--unlisted` keeps it off the public list, reached by its id |
| List | the host | `host listing ID on\|off` (`POST /api/v1/my/worlds/:id`); `host worlds` shows each world's status, listing, and whether it is online with how many players (S2.09) |
| Approve | the owner | The core's admin page `/admin` (`apps/core/src/admin-web.ts`): its own sign-in for accounts with `admin` (`admin account EMAIL --admin on`), a 12-hour session in an `HttpOnly; SameSite=Strict` cookie scoped to `/admin`, a CSRF token per session in every form (compared in constant time); approve or revoke, each written to `world_events` |
| Key | the host | `host key ID`: `GET /api/v1/worlds/:id/key` answers only the world's own account, only while approved; kept in `~/.config/flatchat/worlds/ID.env` (0600). `GET /api/v1/my/worlds` lists the host's worlds |
| Run | the host | `host run DIR --world-id ID [--map-port]`: rebuilds when `world.toml` is newer than the build, then starts the world server with `--world`, `--core`, `--relay` and Cloudflare's STUN |
| Revoke | the owner | The key is deleted; joins and the host channel stop working |

## Capacity Advice (S2.02, Q-L12)

`advise(mbps)`: about 0.25 Mbps a player spread out, 0.75 Mbps with everyone in one place (S0.07); the recommended count fills 60 % of the upload, the maximum 80 %, capped at 200. `host advise` measures by posting 4 MB to Cloudflare's public speed test three times (only when asked); `--mbps` skips the measurement.

## Packaging (S2.02, DR-15)

`node tools/host-tool/scripts/pack.ts [--no-node] [--out DIR]` stages the six workspaces it needs (protocol, sim, content, world server, converter, host tool) as TypeScript Node runs directly, the world templates (`kits/worlds`), the licences and credits; installs production dependencies with scripts off, then rebuilds only node-datachannel (its native binary); adds `bin/flatchat-host`; and, without `--no-node`, Node.js from `.tool-versions` and a `.tar.gz` (74 MB). The container image (`tools/host-tool/Dockerfile`, `node:24.22.0-bookworm-slim`) is built from the `--no-node` folder. CI packs both, runs the package with no Node.js on the path, builds the image and checks the plaza inside it.

## The World's Database (S2.08)

`apps/world-server/src/world/store.ts`: one SQLite file through Node's own `node:sqlite` (`--data FILE`; for a built world the default is `~/.local/share/flatchat/worlds/WORLD_ID.db`). Key-value state in scopes (the world's, and each plugin's from Stage 3: 64 KB a value, 1,000 keys a scope), where each account last stood, and the tables for roles and bans (Stage 3). A `reset` world clears its state and places at every start; a `persistent` one keeps them, and puts a returning account where it left. Moderation records are never reset.

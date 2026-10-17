# Hosting FlatChat from a home PC

How to run the core and a world on one home PC so that friends on other networks can join (step S1.13 of the MVP plan). Everything here runs as your own user: no administrator rights, no open TCP port. Steps that need an account somewhere (Cloudflare, Oracle) or change your router say so.

## How the pieces reach each other

| Piece | What players reach | How it gets through a home router |
|---|---|---|
| The core (accounts, sign-in, worlds) | HTTPS, at an address like `https://core.example.org` | A Cloudflare Tunnel: `cloudflared` on the PC dials out to Cloudflare, which serves the address. No port is opened |
| A world's signalling (the WebRTC offer and answer) | The core's relay: `https://core.example.org/api/v1/worlds/ID/signal` | The world server keeps one WebSocket open to the core (outbound) and answers the offers the core passes on. No port is opened |
| A world's game traffic (positions, voice, chat) | One UDP port, 7778 by default | A mapped port (the world server asks the router with `--map-port`), a port you forward by hand, or a TURN relay when neither works |

## 1. The database and the core

```sh
npm run core:db -- start                  # a private PostgreSQL in ~/.local/share/flatchat/core-db
npm run --silent core:admin -- secret     # prints FLATCHAT_CORE_SECRET=…
```

Make `~/.config/flatchat/core.env` (outside the repository; keep it private and back it up with the database, since the secret seals the worlds' keys):

```sh
FLATCHAT_CORE_DB=postgresql://flatchat@localhost/flatchat?host=%2Fhome%2FYOU%2F.local%2Fshare%2Fflatchat%2Fcore-db
FLATCHAT_CORE_SECRET=…
FLATCHAT_CORE_URL=https://core.example.org
FLATCHAT_CORE_TUNNEL=1
FLATCHAT_CORE_OPERATOR=Your name
FLATCHAT_CORE_CONTACT=an address for privacy questions
```

Then `node --env-file=$HOME/.config/flatchat/core.env apps/core/src/main.ts`. It listens on 127.0.0.1:8787 only.

## 2. The core's address: a Cloudflare Tunnel

This needs a Cloudflare account and a domain whose DNS Cloudflare serves (for FlatChat's own test, kyonax.com once its DNS has moved to Cloudflare: the owner's decision, OQ-8).

```sh
cloudflared tunnel login
cloudflared tunnel create flatchat-core
cloudflared tunnel route dns flatchat-core core.example.org
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: flatchat-core
credentials-file: /home/YOU/.cloudflared/TUNNEL-ID.json
ingress:
  - hostname: core.example.org
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run `cloudflared tunnel run flatchat-core`. `FLATCHAT_CORE_TUNNEL=1` makes the core read each visitor's address from the tunnel's forwarded header (for its rate limits); it trusts that header only from the tunnel on this machine.

## 3. A world on the same PC

The host tool ([tools/host-tool](../tools/host-tool/README.md); `npm run host --` from the repository, or `bin/flatchat-host` from its download) does every step below for any host: `host signin --core URL`, `host request --name "My Plaza"`, then, once the owner has approved it on the core's admin page (`https://core.example.org/admin`), `host key WORLD_ID` and `host run my-world --world-id WORLD_ID --map-port`. The same by hand, on the PC that also runs the core:

Register it as a relayed world, approve it, and keep its key:

```sh
node --env-file=$HOME/.config/flatchat/core.env apps/core/src/admin.ts world register --name "My Plaza" --owner YOU@example.org --address relay
node --env-file=$HOME/.config/flatchat/core.env apps/core/src/admin.ts world approve WORLD_ID     # prints FLATCHAT_WORLD_KEY and FLATCHAT_WORLD_ID once
```

Put those two lines in `~/.config/flatchat/world.env`, build the world (`npm run host -- build my-world`), then:

```sh
node --env-file=$HOME/.config/flatchat/world.env apps/world-server/src/main.ts \
  --transport rtc --world my-world/.built --core https://core.example.org --relay \
  --ice-server stun:stun.cloudflare.com:3478 --map-port
```

Its log says `relay-connected` once the core has accepted its proof, and `port-map` with `ok: true` and the protocol (PCP, NAT-PMP or UPnP) once the router has mapped UDP port 7778. `--map-port` changes your router's settings for as long as the world runs (it renews the lease every half hour and removes it when the world stops); leave it out to forward the port by hand instead.

### On the public list

A running world reports how many players it holds to the core, which shows it in the client's world browser while it is below its recommended count (`[capacity] recommended` in `world.toml`, or `--recommended`); at that count it leaves the list, and players still reach it by its ID or from their favourites up to its maximum. The core's record caps the maximum at what the owner approved (at most 200). `host request --unlisted` keeps a world off the list from the start, and `host listing WORLD_ID on|off` changes it later.

### Plugins and entry rules

A world folder's `plugins/` holds the world's own code ([plugins.md](plugins.md)); `host run` loads it on the world server, and players never download it. Three entry rules come with the world server, and `host plugins my-world add NAME` installs one, printing what it asks to do before it ever runs:

| Rule | Lets in |
|---|---|
| `entry-open` | Everyone the core lets in |
| `entry-verified` | Accounts with a verified email, at least `min_account_days` old (7) |
| `entry-trust` | Accounts at trust level `min_trust` (1) or above, and testers; with `testers_only = true`, only the accounts the core's owner marked as testers |

Change a rule's settings in its `plugin.toml` (for the closed test: `host plugins my-world add entry-trust`, then `testers_only = true` in `my-world/plugins/entry-trust/plugin.toml`). `host plugins my-world` lists what is installed and names any plugin the world server would refuse. The world's log says `plugin-loaded` for each plugin it runs.

### Roles and builds by others

The account that requested the world is its owner: the core's connect token says so, and the world shows it with an Owner badge in the People panel (Tab in the client). There the owner gives the other roles, each a step up: a **builder** may replace the world's files, a **moderator** also kicks, bans and mutes, an **admin** also gives the roles below its own. The world keeps the roles in its own database, so they come back after a restart and are never cleared by a `reset` world.

A builder, an admin or the owner sends a new build from their own PC, without access to yours:

```sh
npm run host -- push my-world --world-id WORLD_ID      # builds my-world, then sends the build to the running world
```

The world checks the whole build as it checks one at start, puts it in place of its built folder (`my-world/.built` on your PC) and restarts on it: `host run` starts it again by itself (a world server started by hand exits with code 75 for you to start it again), and players are brought back in. A build you make yourself later with `host build` or `host run` replaces a pushed one, so keep the world's source folders in step with your builders.

## 4. When the UDP port cannot be reached: TURN

Carrier-grade NAT (common in Colombia: the census in [spikes/s-home.md](spikes/s-home.md) measures how common) means no port can be mapped. Then the game traffic goes through a TURN relay. The core hands out credentials that last an hour, so none is ever built into a client:

| Relay | Settings in core.env |
|---|---|
| coturn on a server you run (for FlatChat's test: an Oracle Always Free VM, "the relay we run") | `FLATCHAT_CORE_TURN_URLS=turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349` and `FLATCHAT_CORE_TURN_SECRET=` the `static-auth-secret` from coturn's `turnserver.conf` (with `use-auth-secret`) |
| Cloudflare Realtime TURN (free up to 1,000 GB a month) | `FLATCHAT_CORE_CF_TURN_KEY=` a TURN key's id and `FLATCHAT_CORE_CF_TURN_TOKEN=` its API token |

The world server receives its own credentials from the core over its WebSocket, so a world behind carrier-grade NAT can relay too.

To check a relay, start the client with `--relay-only`: it then connects to worlds only through the TURN servers the core hands out, as a player behind a NAT that lets nothing else through would. If the join fails with `--relay-only` and works without it, the relay is not reachable or its credentials do not match the core's settings. CI runs the end-to-end test this way against coturn on every change (`node tools/bots/src/e2e.ts CLIENT --relay`).

## 5. Inviting friends

```sh
node --env-file=$HOME/.config/flatchat/core.env apps/core/src/admin.ts invite --email friend@example.org --note "friend"
```

Send them the link it prints. They install the client (the latest CI run's `client-linux` or `client-windows`), and it signs in at the core's address (`--core=https://core.example.org`, or its built-in address once that is the real one).

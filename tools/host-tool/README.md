# Host tool

Everything a host needs to put a world online from a home PC: make a world folder, check it, build it, ask the core to approve it, fetch its key, and run it. The world server, the converter and a capacity advisor in one download for Linux, and as a container image.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Status: Stage 2 (S2.02, S2.09, S2.10); plugins, builds by others, moderation and the host agreement from Stage 3 (S3.01, S3.05, S3.06, S3.07).

| Command | What it does |
|---|---|
| `host signin --core URL` | Signs in through the browser; the session stays in `~/.config/flatchat/host.json`, readable by you only |
| `host new DIR` | A new world folder from the plaza template |
| `host check DIR` | Checks it against the [world format](../../docs/world-format.md) |
| `host build DIR [OUT]` | Converts it into what a world server serves (default `DIR/.built`) |
| `host request --name N [--capacity 50] [--unlisted] --accept-agreement` | Shows the host agreement, then, with `--accept-agreement`, asks the core to approve a world hosted here (at most 200 players); the owner approves it on the core's admin page. `--unlisted` keeps it off the public list: players reach it by its ID |
| `host worlds` | Your worlds: status, listed or not, online, players |
| `host listing WORLD_ID on\|off` | Puts a world on the public list, or takes it off |
| `host key WORLD_ID` | Fetches an approved world's key into `~/.config/flatchat/worlds/WORLD_ID.env` |
| `host run DIR --world-id ID [--map-port]` | Builds the world if it changed, then runs it: players' offers come through the core, so only the UDP port (7778) must be reachable (`--map-port` asks the router). When a builder sends a new build (`host push`), the world restarts on it |
| `host push DIR --world-id ID` | Builds DIR and sends the build to the running world, for a builder, an admin or the owner there; the world checks it, puts it in place and restarts on it ([hosting.md](../../docs/hosting.md#roles-and-builds-by-others)) |
| `host bans WORLD_ID [--data FILE]`, `host unban WORLD_ID ACCOUNT` | The world's bans in force and its moderators' record, read from its database on this machine; lifting one counts at the world's next join |
| `host appeals WORLD_ID`, `host appeal WORLD_ID APPEAL_ID reverse\|uphold [--note N]` | Appeals against the world's bans, and your decision: a reversal lifts the ban in the world, the player reads your note |
| `host plugins DIR [add NAME\|FOLDER]` | Lists the world's plugins (version, hooks, what each asks to do, its settings), or installs one into `DIR/plugins`, showing what it asks for first. NAME is one of the entry rules that come with the world server: `entry-open`, `entry-verified`, `entry-trust` ([plugins.md](../../docs/plugins.md)) |
| `host advise [--mbps N]` | Measures your upload (Cloudflare's public speed test) and suggests a capacity |

From the repository: `npm run host -- COMMAND`. As a download: `node tools/host-tool/scripts/pack.ts` makes `release/host/flatchat-host-VERSION-linux-x64.tar.gz` (with Node.js; `bin/flatchat-host` is the command), and `--no-node` the folder the container image is built from (`tools/host-tool/Dockerfile`). CI builds both and keeps the package 30 days (`flatchat-host-linux`).

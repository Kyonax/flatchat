# Plugins

A plugin is a world's own code: who may come in, a greeting, a game's commands, a moderation rule (step S3.01 of the MVP plan). Plugins run on the world server only, in the engine's language (TypeScript or JavaScript, as Node.js runs it). Players never download them: a client takes data from a world, never code (T-04). This page is for people writing a plugin; the [hosting guide](hosting.md#plugins-and-entry-rules) says how a host installs one.

## A plugin is a folder

```
my-world/
  world.toml
  plugins/
    greeter/
      plugin.toml
      index.ts
```

`plugin.toml` says what the plugin is and what it may do:

```toml
name = "greeter"
version = "1.0.0"
api = 1
description = "Says hello, counts visits and answers /roll."
permissions = ["chat", "store"]
hooks = ["on_join", "on_command"]

[settings]
greeting = "Welcome"
```

The module's default export takes the host interface and returns the hooks it handles:

```ts
import type { HostApi, PluginHooks } from '@flatchat/world-server/plugins';

export default function setup(host: HostApi): PluginHooks {
  return {
    on_join(player) {
      const visits = Number(host.store.get(player.account) ?? '0') + 1;
      host.store.set(player.account, String(visits));
      host.say(`${String(host.settings['greeting'])}, ${player.name} (visit ${visits})`, player.entity);
    },
    on_command(player, name, args) {
      if (name === 'roll') host.say(`${player.name} rolled ${args[0] ?? 'nothing'}`);
    },
  };
}
```

Node.js removes `import type` lines before it runs a file, so the plugin needs no installed package: the import only gives an editor the types.

## plugin.toml

| Field | Required | What |
|---|---|---|
| `name` | yes | Lowercase letters, digits and dashes, 40 at most; one plugin of a name per world |
| `version` | yes | Three numbers, like `1.0.0` |
| `api` | yes | The host interface it was written for: `1` |
| `description` | no | One line, shown by `host plugins` |
| `permissions` | no | What it may do (below) |
| `hooks` | no | The hooks its module handles. A module that returns a hook this list does not name is refused |
| `main` | no | Its module: a file in the folder ending in `.ts`, `.js` or `.mjs` (default `index.ts`) |
| `[settings]` | no | Values it reads as `host.settings`; the host edits them here |

## The hooks

| Hook | When | Arguments | What it answers |
|---|---|---|---|
| `on_join_request` | Before a player joins, after the world's ban list | The player's facts, plus `players` and `capacity` | `{ admit: true }`, or `{ admit: false, reason }`: the player reads the reason (160 characters at most) |
| `on_join` | Once the player is in | `player` | Nothing |
| `on_leave` | When the player leaves or is dropped | `player`, `why` | Nothing |
| `on_chat` | For each chat line not starting with `/` | `player`, `text` | `{ drop: true }` stops the line, `{ text }` changes it, nothing passes it on. Needs `chat` |
| `on_command` | For each chat line starting with `/`, which no one else sees | `player`, `name` (lowercase, 32 characters at most), `args` (16 words at most) | Nothing |
| `on_zone_enter`, `on_zone_exit` | When a player's position enters or leaves one of the world's [zones](world-format.md) | `player`, `{ index, kind }` | Nothing |
| `on_tick` | Every state tick (20 a second by default) | `tick` | Nothing |
| `on_voice_settings` | Arrives with the voice controls (S3.08); not called yet | `player` | `{ range, gain }`. Needs `voice` |

A player's facts come from the connect token the core sealed for this world: `entity` (its number in this world), `account`, `name`, `trust` (0 to 7), `tester`, `emailVerified`, `ageDays` (the account's age) and `under18`. A world never learns a player's email or birth date.

Plugins load in the order of their folders' names. Entry rules run in that order and the first refusal wins; chat lines pass through each `on_chat` in turn.

The default export may be async: the world server waits for it at start. Hooks whose answer matters (`on_join_request`, `on_chat`, `on_voice_settings`) answer at once, since a join or a chat line does not wait; a promise there counts as the hook failing (an entry rule's promise refuses the join). The other hooks may be async, and a rejected promise counts as an error, like a throw.

## The host interface

| Call | Needs | What |
|---|---|---|
| `host.version`, `host.plugin`, `host.world` | | `1`; the plugin's `{ name, version }`; the world's `{ id, name }` |
| `host.settings` | | The `[settings]` table, read-only |
| `host.log(event, fields)` | | A `plugin-log` line in the world server's log |
| `host.players()` | | Everyone in the world, with their facts |
| `host.say(text, to?)` | `chat` | A chat line from the world (no sender), to everyone or to one `entity` |
| `host.kick(entity, reason)` | `moderation` | Ends the player's connection, with the reason |
| `host.ban(account, minutes, reason)` | `moderation` | Bans an account from this world for that many minutes (`undefined`: until lifted) and ends its connection. The ban is kept in the world's database when the world has one |
| `host.unban(account)` | `moderation` | Lifts it |
| `host.forceMute(entity, on)` | `moderation` | Drops the player's voice until lifted or until the player leaves |
| `host.store` | `store` | `get`, `set`, `delete` and `keys`: text values for this plugin only. `set` answers `false` for a value over 64 KB, a key over 128 characters, or a 1,001st key. In the world's database when the world has one (it outlives restarts), in memory otherwise |
| `host.every(ms, fn)`, `host.after(ms, fn)` | `timers` | Runs `fn` repeatedly (no more often than every 50 ms) or once; each returns a function that cancels it |

## Permissions

| Permission | Lets the plugin |
|---|---|
| `chat` | Say things in the world's chat, and change or stop players' chat lines (`on_chat` needs it) |
| `moderation` | Kick, ban and force-mute players |
| `voice` | Change players' voice range and volume (`on_voice_settings` needs it) |
| `store` | Keep data in the world between runs |
| `timers` | Run its code on a timer |

A call the plugin did not ask permission for throws an error, which fails the hook (below). The host sees the permissions before the plugin runs (`host plugins DIR add`). A plugin runs inside the world server's process, so its permissions are a promise the host can read, not a sandbox: install only plugins you trust. The interface is narrow and versioned so that a sandboxed runtime can offer the same calls later (T-04).

## When something fails

- **At start.** A plugin that cannot load is refused with one `plugin-refused` line saying why: no `plugin.toml`, a field that does not check, a hook that needs a permission the plugin did not ask for, the module missing or without a default export, its setup throwing, a hook the module returns that `plugin.toml` does not list. The world runs without it.
- **A hook that throws, or whose promise rejects,** is logged (`plugin-error`, with the plugin, the hook and the message) and the world goes on. Twenty errors in a minute switch the plugin off (`plugin-disabled`) until the world restarts.
- **An entry rule that throws or gives no answer refuses the join.** A world's door stays shut when its lock breaks.

## Minors

Plugins see `under18`. No plugin call loosens a minor's protections: the protections themselves arrive with S3.10 (voice and contact for an account aged 13 to 17 stay friends-only unless a guardian widened them), and whatever a plugin sets stays inside them.

## The entry rules that come with the world server

`host plugins DIR add NAME` installs them ([`apps/world-server/plugins/`](../apps/world-server/plugins/)):

| Plugin | Lets in | Settings | What a refused player reads |
|---|---|---|---|
| `entry-open` | Everyone the core lets in | | |
| `entry-verified` | Accounts with a verified email, at least so many days old | `min_account_days = 7` | "This world asks for a verified email." or "This world asks for an account at least 7 days old." |
| `entry-trust` | Accounts at a trust level or above, and testers; with `testers_only = true`, testers only | `min_trust = 1`, `testers_only = false` | "This world asks for trust level 1 or more." or "This world is open to testers only." |

Trust levels come from the core (S3.09). An account earns levels 1 to 3 with its age, a verified email and the days on which it joined a world: by default 3 days old and 1 active day for level 1, 14 and 5 for level 2, 60 and 20 for level 3 (the core's setting `FLATCHAT_CORE_TRUST`). The core's owner can set a level by hand (`admin account EMAIL --trust N`), which is a floor; levels 4 to 7 come only that way. Testers are the accounts the owner marked (`admin account EMAIL --tester on`): the closed test's door.

## Trying a plugin

`host run` loads the world folder's `plugins/`; the world server alone takes `--plugins DIR` (repeatable), and logs `plugin-loaded` or `plugin-refused` for each one. The world server's tests show how to test one with real joins: [`apps/world-server/test/plugins.test.ts`](../apps/world-server/test/plugins.test.ts) starts a world with plugins and joins it with sealed connect tokens.

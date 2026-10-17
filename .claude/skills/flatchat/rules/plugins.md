---
title: World Plugins — plugin.toml, the Loader, Hooks, the Host Interface and Its Permissions, Failure Policy, the Entry Rules and the Trust They Read
impact: HIGH
impactDescription: A loader that lets one broken plugin stop the world, an entry rule that fails open, a permission checked nowhere, an async hook whose rejection kills the process, or a hook handed the server's internals makes every host's world only as safe as its least careful plugin.
tags: plugins, plugin.toml, plugin loader, Plugins, HostApi, PluginHooks, PluginWorld, PluginPlayer, hooks, on_join_request, on_join, on_leave, on_chat, on_command, on_zone_enter, on_zone_exit, on_tick, on_voice_settings, permissions, HOOK_NEEDS, PERMISSION_MEANS, parseManifest, PluginError, smol-toml, plugin-loaded, plugin-refused, plugin-error, plugin-disabled, async hooks, unhandled rejection, entry rules, entry-open, entry-verified, entry-trust, testers_only, min_trust, min_account_days, bans, force-mute, plugin store, --plugins, host plugins, trust levels, S3.01, S3.05, S3.09, T-04, DR-04
---

Plugins are a world's own code (S3.01): entry rules, greetings, commands, moderation rules. In the MVP they are code the host chose to install, run by the world server only, in the engine's language (DR-04); players never download code (T-04). The guide for plugin authors is `docs/plugins.md`; hosts install them with `host plugins` (`docs/hosting.md#plugins-and-entry-rules`).

## Where It Lives

| Piece | File | What |
|---|---|---|
| The loader | `apps/world-server/src/plugins.ts` | `HOST_API_VERSION` (1), `HOOKS`, `PERMISSIONS`, `HOOK_NEEDS`, `PERMISSION_MEANS`, `parseManifest`, `Plugins` (load, guard, `joinRequest`, `notify`, `chat`, `voiceSettings`, `close`); exported as `@flatchat/world-server/plugins` |
| The server's side | `apps/world-server/src/server.ts` | `WorldServer implements PluginWorld`: `pluginPlayers`, `pluginSay` (a chat with no `from`), `pluginKick`, `pluginBan`/`pluginUnban` (in the world's store, else in memory), `pluginForceMute` (drops voice in `voiceIn`), `pluginStore` (the world's store, else maps with the same `STORE_LIMITS`) |
| The program | `apps/world-server/src/main.ts` | `--plugins DIR` (repeatable): `new Plugins(server, log)`, `load`, `server.usePlugins`, `plugins.close()` at shutdown |
| Entry rules | `apps/world-server/plugins/entry-open`, `entry-verified`, `entry-trust` | Typechecked (`tsconfig.json` includes `plugins/`), packed into the host tool (`pack.ts` copies `plugins`) |
| Host tool | `tools/host-tool/src/plugins.ts` | `host plugins DIR [add NAME\|FOLDER]`: installs and lists, printing what each plugin asks to do before it runs |
| Tests | `apps/world-server/test/plugins.test.ts`, `entry-rules.test.ts`, `tools/host-tool/test/plugins.test.ts` | Fixtures in `test/fixtures/plugins/` (greeter, testers-only, no-permission, bad-toml, setup-throws, undeclared) and `test/fixtures/plugins-async/` (late) |

## The Model (T-04)

| Fact | Consequence |
|---|---|
| A plugin is imported into the world server's process (`import()` of its `main`) | Its permissions are a promise the host reads, not a sandbox; the docs say "install only plugins you trust" |
| It reaches the world only through the `HostApi` object handed to its default export | Never pass it the `WorldServer`, a `Conn`, a socket or the store itself; add a narrow `PluginWorld` method instead |
| Every `HostApi` call that acts checks its permission (`need`) | A missing permission throws `"NAME did not ask for the "P" permission"`, which fails the hook |
| `HOOK_NEEDS`: `on_chat` needs `chat`, `on_voice_settings` needs `voice` | Checked when `plugin.toml` is read, so `host plugins` shows every power a plugin has |
| Player facts are the connect token's | Never an email or a birth date (`PluginPlayer`) |
| `node:vm` is never the sandbox (T12) | Code from strangers (object scripts, after the MVP) runs only in a separate sandboxed process offering the same interface |

## plugin.toml (`parseManifest`, smol-toml)

| Field | Check |
|---|---|
| `name` | `^[a-z0-9][a-z0-9-]{0,39}$`; a second plugin with the same name is refused |
| `version` | `x.y.z` |
| `api` | Exactly `HOST_API_VERSION` |
| `permissions`, `hooks` | Lists of known names; a hook in `HOOK_NEEDS` without its permission is refused |
| `main` | A file name in the folder (`^[A-Za-z0-9_.-]+\.(ts\|js\|mjs)$`, no path), default `index.ts` |
| `settings` | A table, handed to the plugin frozen as `host.settings` |

## Loading and Failure Policy

| Situation | What happens |
|---|---|
| Any load failure | `plugin-refused {folder, why}`; the world runs without it. Causes: no `plugin.toml`, a field that fails, a duplicate name, no `main`, no default export, setup throwing or rejecting (`setup failed: …`), setup returning no object, a returned hook not listed in `plugin.toml` or not a function |
| A plugin loads | `plugin-loaded {name, version, hooks, permissions}`; folders load in name order |
| A hook throws or its promise rejects | `plugin-error {name, hook, why}` through `guard`/`failed`; the world goes on. `guard` attaches a rejection handler to any promise a hook returns: an unhandled rejection stops a Node.js process |
| 20 errors in a minute | `plugin-disabled`; its timers are cleared; it stays off until the world restarts |
| An entry rule throws, answers nothing or answers with a promise | The join is refused (`refuse`, reason `rule`, detail "the world’s entry rule failed" or "…gave no answer"): it fails closed |
| `on_chat` or `on_voice_settings` answers with a promise | Logged as that hook's error; the line passes on unchanged, the settings are ignored |

Order inside the server: a join checks the world's bans (`banOf`, refused as `banned`) and then `joinRequest` (first refusal wins, reason cut to 160 characters). A chat line starting with `/` goes to `on_command` (name lowercased and cut to 32, 16 words at most) and is never broadcast; any other line passes through each `on_chat` in turn. `on_zone_enter`/`on_zone_exit` come from `zoneCheck` after each pose; `on_tick` every tick; `on_leave` in `closed`. `voiceSettings` is not called until S3.08 (voice controls).

## The Entry Rules (S3.05)

| Plugin | Admits | Settings | Refusal |
|---|---|---|---|
| `entry-open` | Everyone the core lets in | | |
| `entry-verified` | `emailVerified` and `ageDays >= min_account_days` | `min_account_days` 7 (0 to 3650) | "This world asks for a verified email." / "This world asks for an account at least N days old." |
| `entry-trust` | `trust >= min_trust` or `tester`; with `testers_only`, `tester` only | `min_trust` 1 (0 to 7), `testers_only` false | "This world asks for trust level N or more." / "This world is open to testers only." |

They import types as `@flatchat/world-server/plugins`: Node.js strips `import type`, so a copy in a world folder outside the repository still runs. The trust level and the tester flag come from the core (S3.09, rule `core-service`).

## Correct vs. Incorrect

**Incorrect:** handing a plugin the server so it can do anything.
```ts
const hooks = mod.default({ server: this.world, settings });
```
**Correct:** hand it the narrow host interface, whose calls check the permissions in `plugin.toml`.
```ts
const hooks = await (mod.default as (host: HostApi) => unknown)(this.host(entry));
```
**Why:** with the server in hand, a greeting plugin can read every connection and send any message; `HostApi` is also what a later sandbox will offer, so code written against it keeps working (T-04).

**Incorrect:** calling a hook and ignoring what it returns.
```ts
try { fn(player); } catch (err) { log(err); }
```
**Correct:** run it through `guard`, which also watches a returned promise.
```ts
this.guard(entry, 'on_join', () => fn.call(entry.hooks, player));
```
**Why:** an `async on_join` that throws returns a rejected promise; left without a handler, Node.js stops the whole world server for one plugin's mistake.

**Incorrect:** admitting a player when the entry rule fails.
```ts
try { verdict = fn(request); } catch { return { admit: true }; }
```
**Correct:** refuse, and say the world's rule failed.
**Why:** a world that shut its door (testers only, verified accounts) must stay shut when its rule breaks.

---
title: Roles, Builds by Others and Moderation — Who May Do What in One World, Checked by the World
impact: HIGH
impactDescription: A role taken from what a client claims, an admin able to crown another admin or touch the owner, a build swapped in before it is checked, or an upload with no window that silently drops pieces turns a host's world over to whoever asks first.
tags: roles, owner, admin, moderator, builder, visitor, ROLES, RIGHTS, can, roleRank, giveRole, storedRole, role message, roster role, People panel, rolesToGive, canGiveTo, host push, pushBuild, put, publish, published, got, window, BuildUploads, uploads.ts, UploadError, .built.incoming, .built.next, exit code 75, updating, rejoin, WorldStore roles, setRole, S3.06, Q-M7, Q-L10
---

Each world has five roles (S3.06), rights growing along `ROLES` in `packages/protocol/src/schema.ts`: `visitor`, `builder` (replace the world's files), `moderator` (kick, ban, mute: S3.07), `admin` (give the roles below its own), `owner`. The world decides every right itself; a client only asks.

## Where It Lives

| Piece | File | What |
|---|---|---|
| Rights | `apps/world-server/src/server.ts` | `Role`, `RIGHTS` (`build`: builder, `moderate`: moderator, `roles`: admin), `roleRank`, `can(role, right)`; `Conn.role`; `storedRole`, `giveRole`, `put`, `publish` |
| Kept roles | `apps/world-server/src/world/store.ts` | The `roles` table: `role`, `setRole` (`visitor` deletes the row), `roles()`; never cleared by a `reset` world. Without a store, an in-memory map |
| The owner | `apps/core/src/worlds.ts` | `claimsFor(..., { ownerId })`: the token's `owner` is true for the account the world was approved for. The owner role is never stored |
| Builds | `apps/world-server/src/world/uploads.ts` | `BuildUploads`: staging, checks, the swap; `UPLOAD_LIMITS` (256 MB a file, 512 MB a build, 4,097 files) |
| The program | `apps/world-server/src/main.ts` | `--world DIR` turns uploads on (`tidy()` first); `onPublished` → `shutdown('updating', 75)` |
| Sending | `tools/host-tool/src/push.ts`, `cli.ts` | `pushBuild(link, token, files)`; `host push DIR --world-id ID` joins through the core like a player (`api.join`, `connectRtc` with the bearer header); `host run` restarts on exit 75 |
| Client | `apps/client/src/renderer/src/world/people.ts`, `session.ts`, `ui/WorldView.vue`, `ui/ClientApp.vue` | `rolesToGive`, `canGiveTo`, `sortPeople`; the People panel (action `people`, Tab); `rejoin()` after a world's `updating` |
| Tests | `apps/world-server/test/roles.test.ts`, `tools/host-tool/test/push.test.ts`, `apps/client/test/people.test.ts`, `tools/bots/src/e2e.ts` (`people: owner`) | |

## Giving Roles (`giveRole`)

| Rule | Why |
|---|---|
| Only from a role with the `roles` right (admin, owner) | A moderator moderates; it does not appoint |
| Only a role below the giver's own | An admin cannot make admins; only the owner can |
| Never over someone at or above the giver | An admin cannot demote another admin or the owner |
| Never `owner`, never over the owner, never to oneself | The owner is whoever the core approved the world for; it comes in the token |
| Applied to every connection of that account, announced as a roster change (`joinedThisTick`) | The roster is the one place clients learn roles |
| Refusals are silent to the client (`role:refused` counted) | The official client offers only what is allowed; a refusal is a modified client |

Do not log account IDs with roles (token claims stay out of logs); the store keeps the record.

## Builds by Others (`put`, `publish`, `got`, `published`)

1. The pusher joins as a player with its own connect token, so its role is the world's to read.
2. `put` pieces (16 KB) per file, in order; the world appends them to `DIR.incoming/<hash>`, hashing as it goes, and answers each with `got` (bytes held). `pushBuild` keeps at most `WINDOW` (512 KB) unacknowledged: a `Link` drops messages beyond its send queue (`LinkStats.dropped`), so an upload without a window loses pieces silently. world.json goes last.
3. `publish` names world.json's hash. The world assembles `DIR.next` (uploaded files, plus files it already holds, hard-linked or copied), runs `loadBuiltWorld` on it (the same check as at start), then renames `DIR` → `DIR.old` and `DIR.next` → `DIR`.
4. `published { ok: true }`, then `onPublished`: the program stops with leave `closing` / detail `updating` and exit code 75. `host run` starts it again; the client's `rejoin()` waits for the world to be online (every 3 s, 20 tries) and joins again.
5. Any failure answers `published { ok: false, detail }` and drops that uploader's staging (`forget`); a closed connection drops it too. One uploader at a time.

## Correct vs. Incorrect

**Incorrect:** trusting a role the client sends, or one kept for the owner.
```ts
case 'role': conn.role = message.role; break;
```
**Correct:** the owner from the sealed token, every other role from the world's own record, every change checked by `giveRole`.
**Why:** anyone can run a modified client; only the core's token and the world's database are the world's to trust.

**Incorrect:** writing an upload straight into the folder the world serves.
```ts
writeFileSync(join(dir, 'world.json'), json);
```
**Correct:** stage in `DIR.incoming`, assemble `DIR.next`, check it with `loadBuiltWorld`, then rename.
**Why:** a half-sent or broken build would replace a working world, and players would download it.

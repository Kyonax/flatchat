---
title: The Protocol Package — Runtime-Neutral TypeScript, Bit-Packed Codecs, Messages, the Connect Token, the Version Handshake and the Golden Packets
impact: CRITICAL
impactDescription: Every program must agree on the protocol byte for byte. A schema change without a version bump, a codec that orders bits or rounds differently, a Node.js API in the shared package, or a decoder that accepts malformed bytes splits clients from servers without an error, breaks the client's renderer bundle, or lets a stranger's packet reach game state (trap T17).
tags: protocol, packages/protocol, version 9, outfit, worn, OUTFIT_MAX, fitOutfit, version 8, proportions, PROPORTIONS, version 7, wear, face, EXPRESSIONS, HAND_POSES, avatar claim, TOKEN_VERSION 2, @flatchat/protocol, wire format, messages, schema, schema.ts, codec, codecs, bit packing, bits, BitWriter, BitReader, varuint, LEB128, fixed point, quantization, rounding, angle, enum, oneOf, string, utf-8, bytes, uuid, optional, list, struct, encodeMessage, decodeMessage, wrong-direction, ProtocolError, cell block, encodeCellBlock, snapshot, pose, roster, voice, voiceBundle, hello, welcome, refuse, handshake, portal, spawn group, travel, height, appearance, teleport, placed, role, ROLES, put, publish, published, got, moderate, MOD_ACTIONS, muted, block, hidden, gain, CONTACT, version 5, version, PROTOCOL_VERSION, fingerprint, SCHEMA_FINGERPRINT, checkVersion, versionPolicy, connect token, sealToken, openToken, TokenError, AES-GCM, web crypto, crypto.subtle, nonce, replay, golden, golden packets, golden files, runGolden, npm run golden, runtime-neutral, browser and node, Buffer, process, tsconfig.web.json, T17, docs/protocol.md, R-17, DR-07
---

This rule governs `packages/protocol` (workspace `@flatchat/protocol`, Apache-2.0): the messages FlatChat's programs exchange, the bit-packed codecs that write them, the connect token the core seals for a world, and the version handshake. The world server imports it as TypeScript run by Node.js; the client bundles it into its sandboxed renderer; the bots and the core will link it too. The wire format's specification is `docs/protocol.md`; the schema itself is `packages/protocol/src/schema.ts`; `packages/protocol/golden/` pins every byte.

## One Package, Two Runtimes

The same files run in Node.js 24 and in Chromium's sandboxed renderer, so the package uses only what both have.

| Use | Never (trap T17, and the browser type check) |
|---|---|
| `Uint8Array`, `DataView`, `TextEncoder`, `TextDecoder` | `Buffer`, `process`, `global`, `__dirname`, `__filename` |
| `crypto.subtle` (AES-GCM), `crypto.getRandomValues` | `import … from 'node:crypto'` or any other Node built-in, `electron` |
| Relative imports that name the `.ts` file (`'./bits.ts'`) | Extensionless relative imports (Node cannot resolve them) |
| `const` objects with `as const` | `enum`, `namespace`, parameter properties (Node strips types; it does not compile) |
| JSON through `import x from '../golden/a.json' with { type: 'json' }` | Reading files at run time |

| Guard | What it checks |
|---|---|
| `tsconfig.json` | `src`, `scripts`, `test` with Node's types |
| `tsconfig.web.json` | `src` alone with the DOM library and no Node types: a Node API fails to type-check |
| T17 in the trap linter | Node built-in imports and Node globals in any `packages/*/src/` file (type-only imports pass) |

`package.json` exports `"."` → `./src/index.ts` and `"./golden"` → `./src/golden.ts`, with no build step. Node runs the TypeScript because npm links the workspace (`node_modules/@flatchat/protocol` → `packages/protocol`) and Node resolves the link to its real path, which is outside `node_modules`. A program that links the package declares it: `"@flatchat/protocol": "*"` in `dependencies` for the world server (it runs from source) or `devDependencies` for the client (Vite bundles it), then `npm install` so the lock file records it. The client's `tsconfig.json` needs `allowImportingTsExtensions` to type-check the package's `.ts` imports; `tsconfig.base.json` has `resolveJsonModule` for the golden files.

## The API

| Need | Call |
|---|---|
| Send a message | `encodeMessage({ type: 'pose', seq, position, yaw, look, stance })` → `Uint8Array` |
| Read a message from a stranger | `decodeMessage(bytes, 'client')` (on a server) or `decodeMessage(bytes, 'server')` (on a client) → `Message`, or throws `ProtocolError` |
| A message's number, sender and channel | `messageDef('pose')` → `{ id, from, channel, body }` |
| A cell's avatars, encoded once per tick | `encodeCellBlock({ cx, cz, full, coarse })` → bytes to put in each watching client's `snapshot.blocks`; `decodeCellBlock(bytes)` on the client |
| JSON for logs, bots and golden files | `messageToJson(m)`, `messageFromJson(json)` (bytes become lowercase hexadecimal) |
| The version and schema | `PROTOCOL_VERSION`, `SCHEMA_FINGERPRINT`, `fingerprintHex()`, `describeSchema()` |
| Check a hello's version | `checkVersion(hello, versionPolicy(coreMinimum))` → `undefined` or the `refuse` body to send |
| Seal a token (the core) | `await sealToken(claims, { key, world, expiresAt })` |
| Open a token (a world server) | `await openToken(sealed, { key, world, now })` → `{ header, claims }`, or throws `TokenError` |
| A new world key (the core, at approval) | `newWorldKey()` → 32 random bytes |
| Run the golden packets | `await runGolden()` from `'@flatchat/protocol/golden'` → `{ protocol, fingerprint, cases, failures }` |

## How Values Are Written

| Point | Rule |
|---|---|
| Bit order | Least significant bit first; byte-aligned 16- and 32-bit values come out little-endian |
| Framing | One type byte, the body, zero padding to a whole byte; at most 65,536 bytes |
| Byte strings | Strings, bytes and UUIDs start on a byte boundary, so encoded cell blocks can be copied whole |
| Lengths and counts | LEB128 in 8-bit groups, at most 5, no needless zero group |
| Rounding | `floor(x + 0.5)`; never banker's rounding (another language must not use its default `Round`) |
| Out of range | Integers and enum names are refused (`out-of-range`, `bad-value`); fixed-point values clamp; angles wrap; non-finite numbers are refused |
| Round trips | Decoding then encoding gives the same bytes, so a server can relay a value without drift |
| Strings | Strict UTF-8 both ways; lone surrogates refused; a leading U+FEFF kept; limits count bytes, not characters |
| Decoded byte strings | Copies, never views into the packet: `new Uint8Array(view)`, never `view.slice()`, because a Node `Buffer`'s `slice()` returns a view (and a `Buffer`); found by the world server's tests on 2026-10-16, pinned by a test in `messages.test.ts` |

The decoder refuses with a `ProtocolError` whose `code` is one of `truncated`, `trailing`, `padding`, `bad-varint`, `unknown-type`, `wrong-direction`, `too-long`, `bad-utf8`, `out-of-range`, `bad-value`. A test feeds it 20,000 random and damaged packets and accepts no other kind of exception.

## Version 6

Version 6 (S3.08) gives each `voiceBundle` frame `range` (u8, metres; 0 for the platform's 25 m) and makes `gain` a byte in 64ths (64 as spoken, 255 nearly four times, the world format's zone limit); schema `1133523f`.

## Version 7

Version 7 (Stage 4) gives the connect token format 2 with `avatar` (`optional(fixedBytes(32))`: the worn avatar's manifest SHA-256, which the core vouches for and the world copies into the roster), the roster's `player` a `face` (`expression` from `EXPRESSIONS`, `left` and `right` from `HAND_POSES`), and two client messages: `wear` (0x16, a fresh connect token of the same account whose `avatar` replaces the roster's; one every 2 s; replays and other accounts refused) and `face` (0x17, kept in the roster; eight a second at most); schema `ebe314c3`.

## Version 8

Version 8 (S4.10) adds `proportions` (`width`, `arms`, `legs`, `head`: u8 percent each) to `hello` and `appearance` (both `optional`: older senders and the tests' hellos leave them out, meaning as made) and to the roster's `player` (required); `PROPORTIONS` is the range (80 to 125) the world fits them into (`fitProportions` in the world server); schema `f2ea7edf`. A version's golden bytes are frozen once written: a change before publishing means putting back the last published `golden/schema.json` (read with `git show HEAD:…`) and writing again.

## Version 9

Version 9 (S5.05) adds `outfit` (0x18, client, reliable: `items`, a `list(worn, OUTFIT_MAX)` of 16 at most) and the roster's `player` an `outfit` (required, after `proportions`). A `worn` item is `{ item: fixedBytes(32), adjust?: { x, y, z: int(8) centimetres; rx, ry, rz: int(8) degrees; scale: u8 percent } }`: the item manifest's SHA-256 in the core's store and, for an attachment, the player's adjustment at its point. The world fits it (`fitOutfit` in the world server: each item once, in the order worn, every adjustment clamped to packages/content's `ADJUST_LIMITS` in these units, 10 cm, 45 degrees, 80 to 125 percent), keeps it in the roster, and takes one change a second; schema `96b318d5`. The bots record each player's outfit in `people` (`WornItem`: the item in hex, the fitted adjustment); `tools/bots/test/outfits.test.ts` is six bots over UDP seeing each other's outfits fitted, and a late joiner reading them all.

## Version 5

Version 5 (Stage 3) is one bump for every world-facing change of the stage; schema `78e23a01`. `role` (`oneOf(ROLES)`) ends each roster player; `role` (0x60, client: an account and a role to give); `moderate` (0x61, client: account, `oneOf(MOD_ACTIONS)` kick/ban/unban/mute/unmute, `minutes` u32 with 0 for until lifted, reason ≤160); `muted` (0x62, server: on, reason); `block` (0x63, client: account, on); `hidden` (0x64, server: the whole list of entities kept apart, ≤256); build uploads `put` (0x45, client: hash, offset, total, ≤16,384 bytes), `publish` (0x46, client: world.json's hash), `published` (0x47, server: ok, detail ≤160) and `got` (0x48, server: hash, bytes held); `gain` (uint 4, eighths, 8 = as spoken, `GAIN_UNITY`) in each `voiceBundle` frame, between `mouth` and `opus`. The token's format is 1 (`TOKEN_VERSION`): claims end with `owner` (bool), `contact` (`oneOf(CONTACT)`: everyone, friends, none), `friends` and `blocks` (`list(uuid, 100)` each), so `hello`'s `token` is `bytes(4096)`. Sealing call sites (tests, bots, offline mode) pass all four; offline mode's guest is `owner: true`.

## Version 4

Version 4 (S2.06, S2.07) added heights and placements: `height` (10 bits, centimetres; 0 = the platform's default) at the end of `hello` and of each roster player, `appearance` (0x13, client, reliable: a new height), `teleport` (0x14, client, reliable: a position and yaw, or a `seat` index into the built world's seats) and `placed` (0x15, server, reliable: where the player is now, the stance, and whether the world moved them); schema `59c0945e`. A roster change lists a player again when only their height changed, so a client counts an arrival only for an entity it did not know.

## Version 3

Version 3 (S2.11) added travel: `portal` (0x50, server, reliable: the world id a portal leads to and the spawn group there, sent once when a player's applied pose enters the portal's box) and `spawn` (a string of 32 bytes at most, after `token`) in `hello`, the spawn group the client asks for; schema `8301ef01`. Version 2 (S2.04) added world content: `content` (0x40, the SHA-256 of the built world's `world.json` and its size, sent after `welcome`), `fetch` (0x41, a file by hash from an offset), `chunk` (0x42, at most 16,384 bytes at an offset of a total), `unfetch` (0x43) and `notFound` (0x44); schema `3ff4d993`. Version 1 (S0.08) gave `voice` and each `voiceBundle` frame a `start` bit and made their `seq` count 20 ms slots, silent ones included; version 0 (S0.06) was the same otherwise. Before content, thirteen messages in four groups, numbered by group: joining 0x01–0x06 (`hello`, `welcome`, `refuse`, `leave`, `ping`, `pong`), state 0x10–0x12 (`pose`, `snapshot`, `roster`), chat 0x20–0x21 (`say`, `chat`), voice 0x30–0x31 (`voice`, `voiceBundle`). Each has a sender (`client`, `server` or `either`) and a channel (`reliable` or `unreliable`). Positions are fixed-point at 1/128 m; snapshots write avatars as offsets inside 32 m cells (`CELL_SIZE`), near ones in full and far ones coarse. `docs/protocol.md` lists every field.

## Changing the Protocol

| Step | Command or file | What enforces it |
|---|---|---|
| 1. Change the schema or a codec | `src/schema.ts`, `src/codec.ts` | — |
| 2. Raise the version by one | `PROTOCOL_VERSION` in `src/schema.ts` | The golden writer refuses new bytes for a version that already has golden bytes |
| 3. Rewrite the golden bytes, then review their diff | `npm run golden -w @flatchat/protocol -- --write` | The tests fail while `golden/` is out of date |
| 4. Update the messages table | `docs/protocol.md` | A test compares every row (number, sender, channel, fields) with the schema |
| 5. Verify | `npm run harness`, and the client's smoke test when the client uses the change | CI runs the golden packets in the server's tests and in the packaged client on Linux and Windows |

**Snapshots in practice (S0.07):** a world server sends several `snapshot` messages for one tick, each about one datagram (1,100 bytes), and a crowded cell arrives as several blocks with the same `cx` and `cz`; a client merges every block of a tick by entity. The first message of a tick carries `ack` and `correction`; the spawn is a `correction` with sequence 0 (`world-networking`).

**Adding a message:** the next free number in its group; a `struct` body without a field named `type`; the right `from` and `channel`; a golden case in `golden/messages.json` (a `value` without `hex`; the writer fills it); a row in `docs/protocol.md`; then the steps above.

**A new program that links the package** (the bots in S0.07, the core in Stage 1) gets a test that runs `runGolden()` through its own import of `@flatchat/protocol/golden`, as `apps/world-server/test/protocol.test.ts` does, so CI proves every program reads and writes the same bytes.

**Golden cases:** values must survive a round trip exactly (positions in multiples of 1/128, angles as multiples of their step), or the writer refuses them. Malformed cases (`golden/invalid.json`, `tokens.json` `rejects`) are hexadecimal, or built from another case with `base` and `truncate` (keep N bytes), `append` (hex) or `xor` (`[byte index, mask]`, negative from the end); the writer recomputes their bytes and checks the error code each must give. The writer's check mode (`npm run golden -w @flatchat/protocol`) changes nothing and exits 1 when the files are out of date.

## The Connect Token and the Handshake

| Point | Rule |
|---|---|
| Format | Version byte (1 since protocol 5), world ID, `expiresAt` (unix seconds), 12-byte random nonce, then the claims sealed with AES-256-GCM; the first 37 bytes are the additional data. The core and every world must read the same format: upgrade them together |
| Key | 32 bytes per world, made by `newWorldKey()` when the core approves the world; never in logs or the repository |
| Lifetime | About 60 s; `now` is unix time in seconds |
| Order of checks in `openToken` | size, format version, world, expiry, tag, claims: `malformed`, `unsupported-version`, `wrong-world`, `expired`, `invalid`, `malformed` |
| Replay | The caller keeps each accepted nonce until its token expires and refuses it again (`token-replayed`) |
| Privacy | The claims carry `under18`, never a birth date; do not log claims or tokens |
| Versions | `versionPolicy(coreMinimum)` accepts this build's version, raised to the core's minimum; `checkVersion` returns `client-outdated`, `server-outdated` or `schema-mismatch` (same number, other fingerprint) |

## Correct vs. Incorrect

**Incorrect:** Node's `Buffer` in the shared package.
```ts
export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
```
**Correct:**
```ts
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
```
**Why:** the client's renderer has no `Buffer`; the bundle fails or throws at run time there, while every Node test passes (T17).

**Incorrect:** decoding a client's packet without saying who sent it.
```ts
const message = decodeMessage(packet);
```
**Correct:**
```ts
let message: Message;
try {
  message = decodeMessage(packet, 'client');
} catch (err) {
  if (err instanceof ProtocolError) return drop(peer, err.code);
  throw err;
}
```
**Why:** without the sender, a client could send `welcome` or `snapshot` to the server; and a malformed packet must cost the sender its packet, never the server its tick.

**Incorrect:** widening a field and rewriting the golden files under the same version.
```ts
say: { id: 0x20, from: 'client', channel: 'reliable', body: struct({ text: str(2048) }) },
```
**Correct:** raise `PROTOCOL_VERSION`, run `npm run golden -w @flatchat/protocol -- --write`, update `docs/protocol.md`.
**Why:** an old server would read a 2,048-byte line as `too-long` and drop it, and nothing would say why; with the version raised, the handshake refuses the mismatch by name.

**Incorrect:** encoding each client's snapshot from the world's entities.
```ts
for (const client of clients) send(client, encodeMessage({ type: 'snapshot', tick, blocks: cellsNear(client).map(encodeCellBlock) }));
```
**Correct:** encode each busy cell once per tick, then reuse its bytes.
```ts
const encoded = new Map(busyCells.map((cell) => [cell.key, encodeCellBlock(cell.block)]));
for (const client of clients) send(client, encodeMessage({ type: 'snapshot', tick, blocks: client.watched.map((k) => encoded.get(k)!) }));
```
**Why:** with 200 players the first form encodes the same cells hundreds of times per tick; spike S0.07's pass line wants serialisations to follow busy cells, not clients.

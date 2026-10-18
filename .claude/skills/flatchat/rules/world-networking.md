---
title: World Networking — the Two Transports, the Join Flow, Interest Management, Snapshots, Voice Forwarding and Chat
impact: CRITICAL
impactDescription: A cell encoded per client, a snapshot larger than a datagram, a negotiated channel created before the remote offer, a send on a closing WebRTC channel, or a join that skips the version, token or replay checks makes 200 players impossible, breaks every WebRTC handshake, crashes a process at shutdown, or lets anyone into a world.
tags: networking, net, transport, transports, link, Link, ServerTransport, udp, raw udp, dgram, encryption, x25519, hkdf, aes-gcm, replay window, reliable, unreliable, segments, acks, sack, retransmit, rto, webrtc, data channel, datachannel, node-datachannel, libdatachannel, ice, ice udp mux, enableIceUdpMux, signaling, sdp, offer, answer, negotiated, dtls, sctp, EPIPE, join, hello, welcome, refuse, roster, connect token, openToken, replay, nonce, capacity, spawn, correction, pose, speed check, interest, interest management, tiers, near, ring, far, cells, grid, CELL_SIZE, 32 m, cell block, encodeCellBlock, snapshot, join snapshot, serialisations, voice, voiceBundle, VoiceRouter, 16 speakers, 25 m, chat, say, ping, pong, world.ts, voice.ts, server.ts, WorldServer, S0.07, S-NET, DR-07, dp-008, sf-004
---

This rule governs the networked parts of `apps/world-server`: the transports in `src/net/`, the world model in `src/world/`, and `src/server.ts`, which joins them. The wire format of every message is the protocol's (`protocol-and-codecs`); this rule is about moving those messages between programs. Spike S0.07 measured all of it with 200 bots (`docs/spikes/s-net.md`; how to run it is in `bots-and-load-tests`).

## The Seam: Link and ServerTransport (`src/net/types.ts`)

| Piece | Meaning |
|---|---|
| `Link` | One connected peer: `send(channel, bytes)`, `close(reason)`, `onMessage((channel, bytes) => …)`, `onClose(reason => …)`, `stats()` |
| Channels | `reliable` (ordered, retransmitted) and `unreliable` (unordered, never retransmitted), as each message's `messageDef(type).channel` says |
| `ServerTransport` | `onLink(link => …)`, `address` (for the ready line), `close()` |
| Importing | Other programs import `@flatchat/world-server/net` (also `/metrics` and `/server`); the package exports nothing else, so importing it never starts a server |

Both transports implement the same seam, so the server and the bots never know which one they use.

## Raw UDP With Our Own Encryption (`src/net/udp.ts`)

| Step | Bytes |
|---|---|
| CONNECT (client → server) | `0x01`, version `0`, the client's X25519 key (32), zero padding to 256 bytes |
| CHALLENGE (server → client) | `0x02`, version, the server's X25519 key (32), a cookie (16): HMAC-SHA256 of the address, the client key and a 30 s epoch. Smaller than CONNECT (no amplification), and the server keeps no state yet |
| CONFIRM (client → server) | `0x03`, version, the client key, the cookie, padding to 256. The server then makes the session |
| DATA (both ways) | `0x10`, sequence number (u64), AES-256-GCM of the payload (16-byte tag); the 9-byte header is the additional data |
| Keys | HKDF-SHA256 of the X25519 secret, salt = client key ‖ server key, info `flatchat-udp-0`: one 32-byte key per direction; a zero secret is refused |
| Payload | Cumulative reliable ack (u32) and a bitmap of the 32 segments after it (u32), then at most one frame: `0x01` unreliable message, `0x02` reliable segment, `0x03` ping, `0x04` close with reason, `0x05` accept |
| Reliable stream | Messages written as LEB128 length + bytes, cut into segments of at most 1,000 bytes, numbered from 1, at most 512 in flight; resent after RTO = srtt + 4·rttvar (50 ms–1 s, doubling per resend up to 2 s); selective acks stop needless resends |
| Liveness | A ping after 1 s without sending, an owed ack after 10 ms, a close after 10 s of silence; a 2,048-packet window refuses replays |

Spike scope: the server's key is not authenticated. Production would carry session keys inside the connect token (the netcode.io pattern), which needs a protocol version bump.

## WebRTC Data Channels (`src/net/rtc.ts`, node-datachannel)

| Point | Rule |
|---|---|
| Channels | Pre-negotiated: id 0 `reliable` (ordered), id 1 `unreliable` (`unordered: true, maxRetransmits: 0`); no in-band channel setup |
| One port | The server's peers share one UDP port: `enableIceUdpMux: true` with `portRangeBegin = portRangeEnd = icePort` |
| Signaling (spike) | `POST /rtc` with JSON `{ type: 'offer', sdp }` (at most 64 KB) on the server's HTTP port; the answer comes back with every candidate gathered (no trickle). Production signaling goes through the core with the connect token |
| Answering side | `setRemoteDescription(offer)` FIRST, then create the negotiated channels; libdatachannel then answers on its own (do not call `setLocalDescription` on the answerer) |
| Isolated networks | `bindAddress: '127.0.0.1'` (`--rtc-bind`) on both ends when only loopback should carry the traffic: on the owner's desktop libjuice's host candidates were the LAN, Tailscale and WARP addresses, never 127.0.0.1 |
| Early messages | `RtcLink` buffers messages that arrive before `onMessage` is set and hands them over when it is |
| Sending | `sendMessageBinary` THROWS (`errno=32`, EPIPE) once a connection is going down: `RtcLink.send` catches it, counts a drop and closes the link. An unreliable message is dropped when more than 256 KB wait in the channel |
| Byte counters | `pc.bytesSent()` and `bytesReceived()` count message bytes, not the wire: measure the wire with the run's nftables counters |

## The Join Flow (`src/server.ts`)

| Step | Rule |
|---|---|
| 1. Link | The first message must be `hello` on the reliable channel within 5 s, or the link is refused with reason `error` |
| 2. Decode | `decodeMessage(bytes, 'client')`, then the channel must match `messageDef(type).channel`; malformed messages are counted and dropped; more than 50 close the link |
| 3. Version | `checkVersion(hello, versionPolicy(coreMinimum))`: a refusal is sent as is |
| 4. Token | `openToken(token, { key, world, now })`: `expired` → `token-expired`, `wrong-world` → `wrong-world`, anything else → `token-invalid`; no world key → refused (`error`) |
| 5. Replay | Each accepted token's nonce is kept until it expires; seen again → `token-replayed` |
| 6. Capacity | At `capacity` players → `full` (an account already in the world makes room for itself) |
| 7. Entry rules | `options.entryRules` in order (the built-in `OPEN_RULE` admits everyone; Stage 3 moves rules into plugins): the first `{ admit: false, detail }` refuses with reason `rule` and the detail (160 characters) |
| 8. One session per account | The same account joining again ends the older connection with `leave` `kicked` ("joined again from somewhere else") |
| 9. Accepted | `welcome`, then the full `roster`; the next tick's snapshot carries every busy cell (the join snapshot) and a `correction` with sequence 0: the spawn the server chose, repeated in every snapshot until the player's first pose arrives (snapshots can be lost; a client ignores a sequence-0 correction once placed) |
| Refusing | Send `refuse`, wait 100 ms, then close the link |

The client's side is `WorldConnection` (`apps/client/src/renderer/src/net/connection.ts`): `join()` resolves once welcomed and placed (`conn.spawn`), so no caller waits for the one-time spawn after the fact; pass `onMessage` to `join()` to see every message from the welcome on (the join's roster and first snapshot arrive while it runs); `next()` sees only messages that arrive after it is called.

## Hosting From Home (`src/net/relay.ts`, `src/net/portmap.ts`)

| Flag | Rule |
|---|---|
| `--core URL [--relay]` | `CoreRelay` keeps a WebSocket to the core's host channel (Node.js's own `WebSocket`, subprotocol `flatchat-host-1`) whenever the world has a core and its key, proves the world key (`hostProof`), reports `status` (players, recommended, maximum) on a change and every 15 s for the world browser (S2.09), takes `limits` (the approved capacity: `WorldServer.capacity` is the smaller of its own and that), applies the `ice` servers the core sends, and reconnects with backoff from 1 s to 30 s. With `--relay` it also answers relayed offers through `RtcServer.answer()` (the same path as the HTTP signalling port); without it, a relayed offer gets an error. `--recommended N` is where the world leaves the public list (default: the built world's, else the capacity). Log lines `relay-connected`, `relay-lost`, `capacity-approved` |
| `--ice-server URL` (repeatable) | STUN or TURN servers in the browser's form; `toDatachannelIce` turns them into node-datachannel's objects (a TURN username with colons survives as a field) |
| `--map-port` | `PortMapper` asks the default gateway to forward the WebRTC UDP port: PCP (MAP, keeping its nonce for renewal and removal), then NAT-PMP, then UPnP IGD (SSDP, then `AddPortMapping`; only a router on a private address); renews at half the lease (1 h), removes the mapping at stop. It changes the host's router, so it is opt-in. Log line `port-map` |

`RtcServer.answer(sdp, label)` resolves with the answer once ICE has gathered and opens the link in the background; the HTTP handler and the relay both call it.

## World Content (`src/world/content.ts`, S2.04)

`--world BUILT_DIR` serves a built world (the converter's `world.json` and `content/<sha256>`): `loadBuiltWorld` checks world.json with `parseBuiltWorld` and every file's hash, and `builtOptions` takes the world's bounds, spawn points (from every scene, each with its group; a join picks among the first scene's, or among the group its `hello` names when the world has it, S2.11), portals (from every scene), solids (an axis-aligned box around each collider, for the height check), flying and maximum capacity. After `welcome` the server sends `content`; a player's `fetch` queues a file (64 at most), `unfetch` drops it, an unknown hash gets `notFound`. `ContentServer.step()` runs on the voice ticker (50 Hz): 16 KB chunks, at most 2 MB/s a player and 6 MB/s in total, so downloads never starve the game. The client downloads, checks and caches it (`client-app`).

## In One Program (`src/net/local.ts`, S2.13)

`LocalTransport` (transport name `local`) and `LocalLink` let a program host a world and play it without a network: `connect(deliver, ended)` makes a link whose `send` hands the world's messages to `deliver`, whose `receive` takes the player's, and whose `close` ends both sides once. The client's offline mode runs the world server this way in its main process; the package exports it as `@flatchat/world-server/local` (with `./content` and `./navigation`), apart from `./net`, which loads node-datachannel's native binary. `server.ts` takes `performance` from `node:perf_hooks`, so a DOM-typed program (the client) type-checks it.

## Heights, Seats and Teleports (`src/server.ts`, S2.06, S2.07)

| Part | Rule |
|---|---|
| Heights | `fitHeight(cm)`: 0 becomes `DEFAULT_HEIGHT_CM` (175, `BODY.height`), then clamped into the world's range (`heights`, from `[avatars]` in world.toml; `DEFAULT_HEIGHTS` 0.5–3 m for maps made in code). The roster carries the fitted height; `appearance` changes it at most once a second and goes out as a roster change |
| Seats | `teleport` with `seat`: the built world's seats from every scene, in order (`seats` in `builtOptions`); within `TELEPORT.seatReach` (3 m) of the player, placed at the seat with stance `sitting` |
| Teleports | A clicked spot within `TELEPORT.range` (40 m), at most one teleport or seat a second (`TELEPORT.everyMs`), inside the world. Where it lands (`landing`): anywhere in a flying world; on a built world, the nearest point of its navigation mesh within 0.5 m across and 1 m up or down (`WalkableSurface` in `src/world/navigation.ts`, recast-navigation in Node, loaded by `main.ts` from the converter's mesh; the mesh lies within a cell height, 0.1 m, of the surface); on a map made in code, not inside a box and at most 0.6 m above the ground under it (`groundBelow`), snapped down to it |
| The answer | `placed`, accepted or not, with where the player is. `World.place` moves the player, updates the cell and resets the pose clock, so a pose the client sent from the old place is corrected back to the new one. Events `teleport:placed`, `teleport:refused`, `appearance` |
| Typing | The world server's tsconfig uses Bundler resolution, like the converter's: recast-navigation's declarations use extensionless imports |

## Avatars and Faces (`src/server.ts`, S4.05, S4.07)

The roster's player carries the worn avatar's manifest hash from the connect token (`claims.avatar`) and a face (neutral, both hands relaxed at the join). `wear` opens a fresh token with the world's key, refuses a replayed nonce or another account's token, and replaces the roster's `avatar` (one every `WEAR_EVERY_MS`, 2 s); `face` sets the roster's face (one every `FACE_EVERY_MS`, 125 ms, and only when it changes); both are announced as a roster change. The world never fetches an avatar: clients do, from the core.

## Portals (`src/server.ts`, S2.11)

After each applied `pose` the server checks the player's position against the portal boxes (`insideBox` from `packages/content`: a box turned about y). Entering one sends `portal` (the world id and the spawn group, cut to 32 bytes) once; the player must leave the box before the next. A player who spawns inside a portal starts as already in it, so arrivals are never bounced straight back. The world never hands out a connect token for the other world: the client asks the core (`client-app`). A player arriving with a spawn group skips a persistent world's remembered place. Events `portal` and `leave:travel` count it.

## Interest Management and Snapshots (`src/world/`)

| Point | Rule |
|---|---|
| Cells | 32 m (`CELL_SIZE`); `grid.ts` keys a cell by its pair of int 16 indices |
| Tiers | By the distance from the viewer to the cell's square: within 15 m near (full blocks every tick, 20 Hz), within 50 m the ring (full blocks every 4th tick, 5 Hz), the rest far (coarse blocks every 20th tick, 1 Hz). Each viewer's slower tiers run on its own phase (`entity % 20`) |
| Encoding once | `World.tick()` encodes each busy cell at most once per form per tick (full, coarse) and copies the bytes into every snapshot that needs them: encodings follow busy cells, never viewers |
| Crowded cells | More than 96 full (or 160 coarse) avatars split into several blocks with the same `cx`, `cz`; a client merges blocks |
| Packing | A viewer's blocks go out in near → ring → far order in snapshot messages of about 1,100 bytes, so each fits one datagram; the first message of a tick carries `ack` and any `correction` |
| Poses | Newer sequence only (16-bit wrap); `checkMove` from `packages/sim` (running plus 15 % with 0.75 m of slack; no rising above a jump's reach where flying is off), otherwise a `correction` puts the player back; positions clamp to the world square. Read `movement-sim` |
| Entity ids | An id freed this tick is reused only after the roster has announced its leave, so no roster names two players with one id |

## Voice and Chat

| Point | Rule |
|---|---|
| Voice in | At most 60 frames per second per player (more are counted and dropped); frames queue per speaker, at most 3 |
| Voice out | Every 20 ms (a second ticker at 50 Hz): one frame from each of up to 16 speakers within each speaker's range of the listener, nearest first, in one `voiceBundle`; never decoded |
| Voice rules (S3.08) | `VoiceRouter.step(world, rules)`: `rangeOf`/`gainOf` per speaker and `canHear(listener, speaker)`, from `WorldServer.voiceRules`. Each `Conn` keeps `voiceRange`, `voiceGain` (64ths), `quiet`, `privateZone`, set by `updateVoice` at the join and on every zone change (`zoneCheck`, also run at the join): a `voice` zone's range and gain, then the plugins' `on_voice_settings`, a minor clamped to the world's defaults; quiet zones block both ways, private zones keep voice among those inside. Each frame carries `gain` and `range` (0 for the default) so the client's falloff ends where the world stops forwarding (protocol version 6) |
| Apart and reach (S3.10, S3.11) | `apart(a, b)`: either's `blocks` (the token's, plus `block` messages during the visit) holds the other; `mayReach(a, b)`: a minor (`under18`) is reached only by its token's `friends` (`contact` `friends`), by everyone (`everyone`, a guardian widened it) or by nobody (`none`), both ways. `canHear` and `chat` delivery need `!apart && mayReach`; `updateHidden` sends each player its `hidden` entities (blocked pairs) at every join, leave and block, only when the list changed. A plugin's settings never get past them (voice routing applies the rules after `on_voice_settings`); the world's own `say` reaches everyone |
| Chat (S1.10) | World-wide: relayed as `chat` to every player, the speaker included. `cleanChat`: control characters and direction marks (C0, C1, U+200E/F, U+202A–U+202E, U+2066–U+2069) become spaces, whitespace collapses, at most 280 characters, empty lines dropped. A token bucket per player: a burst of 5, then one every 1.5 s; more are counted (`chat:throttled`) and dropped |
| Ping | `pong` echoes `id` and `time` at once |

## Correct vs. Incorrect

**Incorrect:** encoding each viewer's cells for that viewer.
```ts
for (const viewer of players) send(viewer, encodeMessage({ type: 'snapshot', tick, blocks: cellsNear(viewer).map(encodeCellBlock) }));
```
**Correct:** `World.tick()` caches each cell's encoded blocks for the tick and packs the cached bytes per viewer.
**Why:** with 200 players the first form encodes each crowded cell dozens of times per tick; S0.07's pass line wants encodings to follow busy cells.

**Incorrect:** creating the negotiated channels before the remote offer on the answering side.
```ts
const pc = new PeerConnection('world', config);
const dc = pc.createDataChannel('reliable', { negotiated: true, id: 0 });
pc.setRemoteDescription(offer.sdp, 'offer');
```
**Correct:** `pc.setRemoteDescription(offer.sdp, 'offer')` first, then `createDataChannel(…)`.
**Why:** libdatachannel negotiates as soon as a channel exists and makes its own offer; both ends then act as the DTLS client and the handshake fails with "unexpected message".

**Incorrect:** `dc.sendMessageBinary(bytes)` without a guard.
**Correct:** `RtcLink.send`, which catches the throw and closes the link.
**Why:** during a shutdown it throws EPIPE inside a timer and kills the whole process; it lost a swarm of 13 bots in the first 50-bot WebRTC run.

**Incorrect:** one snapshot message per viewer with every due block.
**Correct:** packing into messages of about 1,100 bytes.
**Why:** a larger datagram is fragmented by IP; losing any fragment loses the whole snapshot, and SCTP fragments it in the same way.

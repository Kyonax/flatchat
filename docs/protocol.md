# The FlatChat protocol, version 1

How FlatChat's programs talk: the client, the world server, the bots and the core. This page is the specification; the reference implementation is [`packages/protocol`](../packages/protocol) (TypeScript, Apache-2.0), the machine-readable schema is [`golden/schema.json`](../packages/protocol/golden/schema.json), and the golden packets in the same folder pin every byte. Version 0 was the first, built in Stage 0 (S0.06) and measured with 200 bots in spike S0.07. Version 1 (spike S0.08) gives every voice frame a `start` bit and makes its `seq` count 20 ms slots: see [Versions](#versions).

## Transport

The world connection runs over WebRTC data channels (decision DR-07): the world server listens on one UDP port for every player, DTLS encrypts the traffic, and no certificate authority is needed. Each player has two channels:

| Channel | Settings | Carries |
|---|---|---|
| reliable | ordered, retransmitted | joining, the roster, chat, leaving |
| unreliable | unordered, `maxRetransmits: 0` | poses, snapshots, voice, pings |

One data-channel message carries one protocol message. Keep unreliable messages under 1,200 bytes: a larger one travels in fragments that are lost together. Spike S0.07 also measures raw UDP with our own encryption; if it replaces WebRTC, it carries the same messages on the same two kinds of channel.

## Messages on the wire

A message is one byte giving its type, then its body, padded with zero bits to a whole byte. No message is longer than 65,536 bytes. A decoder refuses, with these codes:

| Code | When |
|---|---|
| `truncated` | the bytes end before the message does (an empty message included) |
| `trailing` | bytes remain after the message |
| `padding` | a padding bit is not zero |
| `bad-varint` | a length or count uses more bytes than it needs, or more than 5 |
| `unknown-type` | no message has this type number |
| `wrong-direction` | a client sent what only a server sends, or the other way round |
| `too-long` | a string, byte string, list or message over its limit |
| `bad-utf8` | a string that is not valid UTF-8 |
| `out-of-range` | a value outside what its field allows, such as an enum index past the end |

Every value has exactly one encoding, so equal messages are equal bytes.

## Bits

Bits are packed least significant first: the first bit written is bit 0 of byte 0, and a value of *n* bits is written from its lowest bit up. A byte-aligned 16- or 32-bit value therefore comes out little-endian. Byte strings (strings, bytes, UUIDs) start on a byte boundary, after zero padding bits.

A **length or count** is written as 7-bit groups, lowest first, each in 8 bits with the top bit set when another group follows (LEB128). It takes at most 5 groups, is at most 2^32 − 1, and has no needless trailing zero group (`80 00` is refused).

## Field kinds

| Kind | Written as | Value |
|---|---|---|
| uint *n* | *n* bits (1 to 32) | an integer from 0 to 2^*n* − 1 |
| int *n* | *n* bits, two's complement (2 to 32) | an integer from −2^(*n*−1) to 2^(*n*−1) − 1 |
| u64 | the low 32 bits, then the high 32 bits | an integer; the TypeScript library holds it as a number, so up to 2^53 − 1 |
| bool | 1 bit | true or false |
| fixed *n*, *f*, signed or not | *k* = floor(*v* × 2^*f* + 0.5), clamped to *n* bits (two's complement when signed) | *k* / 2^*f* |
| angle *n* | *k* = floor(*v* / *s* + 0.5) mod 2^*n*, where *s* = π / 2^(*n*−1) | *k* × *s*, radians in [0, 2π) |
| enum | the index, in ceil(log2(count)) bits, at least 1 | one of the listed names |
| string *max* | the UTF-8 byte length (at most *max*), padding to a byte, the bytes | text; a leading U+FEFF is kept |
| bytes *max* | the length (at most *max*), padding to a byte, the bytes | a byte string |
| fixedBytes *n* | padding to a byte, *n* bytes | a byte string of length *n* |
| uuid | padding to a byte, 16 bytes | lowercase `8-4-4-4-12` hexadecimal |
| optional | 1 bit, then the value when the bit is 1 | the value, or absent |
| list *max* | the count (at most *max*), then each item | an array |
| struct | each field in order | an object |

Rounding is floor(*x* + 0.5) everywhere: halves go up, never to the nearest even number (C#'s `Math.Round` default, for one, does that). Fixed-point values outside the range are clamped; angles wrap; integers out of range, non-finite numbers and malformed strings are refused by the encoder. Decoding a value and encoding it again gives the same bytes, so a server that relays a value never changes it.

## Positions

The y axis points up. A **position** is x and z as fixed 28 bits with 7 fraction bits (±1,048,576 m in 1/128 m steps) and y as fixed 18 bits with 7 fraction bits (±1,024 m).

Snapshots write avatars relative to **cells** of 32 m: cell (*cx*, *cz*) = (floor(*x* / 32), floor(*z* / 32)), and an avatar's x and z are offsets from the cell's corner. Near avatars use offsets of 12 bits with 7 fraction bits (1/128 m) and the full height; far avatars, drawn as proxies, use offsets of 8 bits with 3 fraction bits (1/8 m) and a height of 12 bits with 1 fraction bit (1/2 m).

The body's facing (`yaw`) is an angle of 10 bits (0.35°), 6 bits for far avatars; the head's pitch (`look`) is fixed 8 bits with 6 fraction bits, in radians, up positive (0.9° steps). The stance is one of `standing`, `crouching`, `sitting`, `jumping`, `falling`, `flying`.

A **cell block** is cx and cz (int 16 each), then the cell's near avatars (`full`: id, x, y, z, yaw, look, stance) and far avatars (`coarse`: id, x, y, z, yaw), each list at most 256. A world server encodes each cell once per tick and copies the same bytes into the snapshot of every client that sees that cell, so its work follows the number of busy cells, not the number of players.

A world server may send **several snapshots for one tick**, each kept to about one datagram (1,100 bytes), and may split a crowded cell into **several blocks** with the same cx and cz. A client merges every block it receives for a tick by entity. The first snapshot of a tick carries `ack` and any `correction`; a player's spawn arrives as a `correction` with sequence 0, repeated in every snapshot until the server has the player's first pose (snapshots can be lost).

## The messages

| Message | Type | Sent by | Channel | Fields | What it does |
|---|---|---|---|---|---|
| `hello` | 0x01 | client | reliable | protocol, fingerprint, build, token | Opens a join: the client's protocol version, its schema fingerprint, its build name (32 bytes at most) and the connect token (256 bytes at most) |
| `welcome` | 0x02 | server | reliable | protocol, build, world, entity, tickHz, tick | Accepts the join: the server's version and build, the world's ID, the player's entity number, the tick rate and the current tick |
| `refuse` | 0x03 | server | reliable | reason, protocolMin, protocolMax, detail | Refuses the join, with a reason (below), the versions the server accepts and a detail of 160 bytes at most |
| `leave` | 0x04 | either | reliable | reason, detail | Ends the connection: `quit`, `travel`, `kicked`, `banned`, `timeout`, `closing` or `error` |
| `ping` | 0x05 | either | unreliable | id, time | Asks for a pong; `time` is the sender's clock in milliseconds, modulo 2^32 |
| `pong` | 0x06 | either | unreliable | id, time | Answers a ping with its id and time, for the round trip |
| `pose` | 0x10 | client | unreliable | seq, position, yaw, look, stance | The player's own avatar, 20 times a second, numbered by `seq` (wrapping at 2^16) |
| `snapshot` | 0x11 | server | unreliable | tick, ack, correction, blocks | The server's tick, the last pose it applied (`ack`), where it put the player when a pose broke the rules (`correction`: seq, position, yaw) and the cell blocks this player sees (each 4,096 bytes at most, 256 at most) |
| `roster` | 0x12 | server | reliable | full, players, left | Who is in the world: the whole list at join (`full`), then changes; each player has an entity number, account ID, display name (64 bytes at most), trust level (0 to 7) and the avatar's content hash, which the client fetches from the core, never from the host |
| `say` | 0x20 | client | reliable | text | A chat line from the player, 1,024 bytes at most; the server's own length and rate limits apply on top |
| `chat` | 0x21 | server | reliable | from, text | A chat line to show: from an entity, or from the world when `from` is absent; always shown as text, never as HTML |
| `voice` | 0x30 | client | unreliable | seq, start, mouth, opus | One 20 ms Opus frame (255 bytes at most) and the mouth shapes that go with it; `seq` counts 20 ms slots, the silent ones too, and `start` marks the first frame after silence |
| `voiceBundle` | 0x31 | server | unreliable | frames | Up to 16 speakers' frames for one listener and one 20 ms step, each with the speaker's entity number, its `seq` and `start` as sent |

The mouth shapes are the five VRM visemes `aa`, `ih`, `ou`, `ee`, `oh` and the `level` (loudness), each 0 to 15: three bytes per frame, so lips move with the voice.

A speaker's client sends voice only while it hears speech. Its `seq` still advances every 20 ms through the silence, so a listener knows how long a gap was, and the first frame after a gap has `start` set: the listener plays silence until it rather than concealing the gap as lost frames. Within a run of frames, a missing `seq` is a lost frame (RTP's sequence number and marker bit, in one counter).

## The handshake

1. The client asks the core for a connect token for one world, and gets the world's address, the relay's address when it needs one, and the sealed token.
2. The client connects and sends `hello`.
3. The world server checks, in order: the version (below), the token (its checks, then a nonce it has already seen is refused), then its entry rules, its capacity and its bans.
4. It answers `welcome` and the full `roster`, then snapshots; or `refuse`.

**Versions.** A world server accepts its own protocol version, raised to the core's minimum when the core sets one higher (risk R-17: hosts run their own servers, and old ones must be turned away cleanly). The client's `fingerprint` must equal the schema fingerprint of the version it claims, so two development builds with different schemas under one number refuse each other instead of misreading each other.

| Refusal | Meaning |
|---|---|
| `client-outdated` | The client's version is below what the server accepts: update the client |
| `server-outdated` | The client is newer than the server, or the server is older than the core allows |
| `schema-mismatch` | Same version number, another schema (a development build) |
| `token-invalid` | The token does not open with this world's key, or was changed |
| `token-expired` | The token's time ran out |
| `token-replayed` | The token was used already |
| `wrong-world` | The token admits to another world |
| `full` | The world is at its capacity |
| `banned` | The account is banned from this world |
| `rule` | An entry rule refused; `detail` holds the rule's own words |
| `closing` | The world server is shutting down |
| `error` | Anything else; the server's log says what |

## The connect token

The core vouches for a player to one world with a connect token, the pattern of netcode.io: the core and each approved world share a 32-byte key, issued when the world is approved. The client carries the token without being able to read or change it; the world server opens it without calling the core. It lives about 60 seconds.

| Bytes | Field |
|---|---|
| 0 | format version (0) |
| 1–16 | the world's ID (UUID) |
| 17–24 | `expiresAt`: unix time in seconds (u64) |
| 25–36 | `nonce`: 12 random bytes, new for every token |
| 37 to the end − 16 | the claims, encrypted |
| the last 16 | the authentication tag |

The cipher is AES-256-GCM, with the world's key, the nonce as the IV, bytes 0–36 as the additional data and a 128-bit tag, so the readable part cannot be changed either. The claims are a struct: `account` (UUID), `name` (string, 64 bytes at most), `trust` (uint 3), `tester`, `emailVerified`, `under18` (bool each) and `ageDays` (u16, the account's age). A minor's birth date never travels: only `under18`.

A world server checks: at least 53 bytes (else `malformed`), the format version (`unsupported-version`), the world (`wrong-world`), the time (`expired` once the clock reaches `expiresAt`), the tag (`invalid`), and that the claims parse (`malformed`). It then refuses a nonce it has accepted before, until that token expires.

## Golden packets

[`packages/protocol/golden/`](../packages/protocol/golden) holds the cases every implementation must pass:

| File | Holds |
|---|---|
| `schema.json` | The version, the schema fingerprint and the whole schema as data |
| `messages.json` | A value for every message type and its exact bytes |
| `blocks.json` | Cell blocks and their bytes |
| `tokens.json` | Tokens sealed with a fixed key and nonce, and changed or misused tokens with the error each must give |
| `invalid.json` | Malformed messages and blocks, with the error code each must give |

Every program that links the library runs them: the protocol's own tests, the world server's tests, and the client's smoke test inside its bundled renderer, on Linux and on Windows in CI. An implementation in another language runs the same files.

## Changing the protocol

1. Change [`src/schema.ts`](../packages/protocol/src/schema.ts) or a codec.
2. Raise `PROTOCOL_VERSION` there by one.
3. Run `npm run golden -w @flatchat/protocol -- --write` and review what changed in `golden/`.
4. Update this page's tables.
5. Run `npm run harness`.

The golden writer refuses step 3 without step 2, the tests fail while the golden files or this page are out of date, and the handshake turns away a peer of another version or schema.

## Versions

| Version | Changed |
|---|---|
| 0 | The first: thirteen messages, the connect token, the version handshake (S0.06) |
| 1 | `voice` and each `voiceBundle` frame gain `start`, and their `seq` counts 20 ms slots including silence: a voice gate that closes and reopens within a moment left gaps the listener could not see, and frames after them played late or were concealed (S0.08, measured with real speech) |

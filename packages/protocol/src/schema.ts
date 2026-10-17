// SPDX-License-Identifier: Apache-2.0
// Protocol v0: every message the client, the world server, the bots and the core exchange, the
// cell block a snapshot carries, and the connect token's layout. Anything declared here feeds
// SCHEMA_FINGERPRINT; when it changes, the golden writer refuses to record it until
// PROTOCOL_VERSION goes up (docs/protocol.md, "Changing the protocol").
import {
  angle,
  bool,
  bytes,
  type Codec,
  fixed,
  fixedBytes,
  int,
  list,
  oneOf,
  optional,
  str,
  struct,
  u16,
  u32,
  u64,
  u8,
  uint,
  uuid,
} from './codec.ts';

/** Goes up by one with every change to the messages or how they are written. */
export const PROTOCOL_VERSION = 3;

/** The largest message any program sends or accepts, in bytes. */
export const MAX_MESSAGE_BYTES = 65_536;

/** Snapshots write positions relative to square cells this many metres wide. */
export const CELL_SIZE = 32;

// Distances are metres in steps of 1/128 m (7.8 mm), except in the far tier.
const coord = fixed(28, 7, true); // x or z anywhere: ±1,048,576 m
const height = fixed(18, 7, true); // y: ±1024 m
const offset = fixed(12, 7, false); // x or z inside a cell: 0 to 32 m
const coarseOffset = fixed(8, 3, false); // the far tier: 1/8 m steps
const coarseHeight = fixed(12, 1, true); // the far tier: 1/2 m steps, ±1024 m

export const position = struct({ x: coord, y: height, z: coord });
const yaw = angle(10); // the body's facing, 0.35° steps
const look = fixed(8, 6, true); // the head's pitch in radians, up positive: 1/64 rad (0.9°) steps, ±2 rad

export const STANCES = ['standing', 'crouching', 'sitting', 'jumping', 'falling', 'flying'] as const;
const stance = oneOf(STANCES);

/** An avatar near enough to draw in full (sent at 20 Hz near, 5 Hz in the next ring). */
const fullEntity = struct({ id: u16, x: offset, y: height, z: offset, yaw, look, stance });
/** A distant avatar, drawn as a proxy (sent at 1 Hz): where it is and where it faces. */
const coarseEntity = struct({ id: u16, x: coarseOffset, y: coarseHeight, z: coarseOffset, yaw: angle(6) });

/** One cell's avatars. The cell's corner is (cx × CELL_SIZE, cz × CELL_SIZE); each avatar's x and
 *  z are offsets from it. A world server encodes a cell once per tick and copies the same bytes
 *  into the snapshot of every client that sees it. */
export const CELL_BLOCK = struct({
  cx: int(16),
  cz: int(16),
  full: list(fullEntity, 256),
  coarse: list(coarseEntity, 256),
});

/** The five VRM mouth shapes and the loudness, each 0 to 15 (15 = full): three bytes that ride
 *  with every voice frame, so lips and voice stay together. */
const mouth = struct({ aa: uint(4), ih: uint(4), ou: uint(4), ee: uint(4), oh: uint(4), level: uint(4) });

/** One player in the world's roster. `avatar` is the content hash the client fetches from the
 *  core's asset store, never from the host. */
const player = struct({
  entity: u16,
  account: uuid,
  name: str(64),
  trust: uint(3),
  avatar: optional(fixedBytes(32)),
});

export const REFUSE_REASONS = [
  'client-outdated',
  'server-outdated',
  'schema-mismatch',
  'token-invalid',
  'token-expired',
  'token-replayed',
  'wrong-world',
  'full',
  'banned',
  'rule',
  'closing',
  'error',
] as const;

export const LEAVE_REASONS = ['quit', 'travel', 'kicked', 'banned', 'timeout', 'closing', 'error'] as const;

/** Who may send a message: the decoder refuses it from the other side. */
export type Sender = 'client' | 'server' | 'either';
/** reliable: ordered and retransmitted; unreliable: unordered, never retransmitted. */
export type Channel = 'reliable' | 'unreliable';

export interface MessageDef {
  id: number;
  from: Sender;
  channel: Channel;
  body: Codec<unknown>;
}

export const MESSAGES = {
  // Joining (docs/protocol.md, "The handshake").
  hello: {
    id: 0x01,
    from: 'client',
    channel: 'reliable',
    // `spawn` (version 3): the spawn group a portal named (S2.11), empty for the world's own.
    body: struct({ protocol: u16, fingerprint: u32, build: str(32), token: bytes(256), spawn: str(32) }),
  },
  welcome: {
    id: 0x02,
    from: 'server',
    channel: 'reliable',
    body: struct({ protocol: u16, build: str(32), world: uuid, entity: u16, tickHz: u8, tick: u32 }),
  },
  refuse: {
    id: 0x03,
    from: 'server',
    channel: 'reliable',
    body: struct({ reason: oneOf(REFUSE_REASONS), protocolMin: u16, protocolMax: u16, detail: str(160) }),
  },
  leave: { id: 0x04, from: 'either', channel: 'reliable', body: struct({ reason: oneOf(LEAVE_REASONS), detail: str(160) }) },
  ping: { id: 0x05, from: 'either', channel: 'unreliable', body: struct({ id: u16, time: u32 }) },
  pong: { id: 0x06, from: 'either', channel: 'unreliable', body: struct({ id: u16, time: u32 }) },
  // Moving and seeing others.
  pose: { id: 0x10, from: 'client', channel: 'unreliable', body: struct({ seq: u16, position, yaw, look, stance }) },
  snapshot: {
    id: 0x11,
    from: 'server',
    channel: 'unreliable',
    body: struct({
      tick: u32,
      ack: optional(u16),
      correction: optional(struct({ seq: u16, position, yaw })),
      blocks: list(bytes(4096), 256),
    }),
  },
  roster: {
    id: 0x12,
    from: 'server',
    channel: 'reliable',
    body: struct({ full: bool, players: list(player, 256), left: list(u16, 256) }),
  },
  // Text chat.
  say: { id: 0x20, from: 'client', channel: 'reliable', body: struct({ text: str(1024) }) },
  chat: { id: 0x21, from: 'server', channel: 'reliable', body: struct({ from: optional(u16), text: str(1024) }) },
  // Voice: Opus frames of 20 ms; the server forwards them without decoding. `seq` counts 20 ms
  // slots, the silent ones too (version 1), so a gap shows its length; `start` marks the first
  // frame after silence, so a listener plays silence across the gap instead of concealing it.
  voice: { id: 0x30, from: 'client', channel: 'unreliable', body: struct({ seq: u16, start: bool, mouth, opus: bytes(255) }) },
  voiceBundle: {
    id: 0x31,
    from: 'server',
    channel: 'unreliable',
    body: struct({ frames: list(struct({ from: u16, seq: u16, start: bool, mouth, opus: bytes(255) }), 16) }),
  },
  // World content (version 2, S2.04): the server names its built world by the SHA-256 of its
  // world.json; the client fetches what its cache lacks, file by file, from any offset (resuming
  // after a lost connection), and checks each file's hash before using it.
  content: { id: 0x40, from: 'server', channel: 'reliable', body: struct({ world: fixedBytes(32), size: u32 }) },
  fetch: { id: 0x41, from: 'client', channel: 'reliable', body: struct({ hash: fixedBytes(32), from: u32 }) },
  chunk: { id: 0x42, from: 'server', channel: 'reliable', body: struct({ hash: fixedBytes(32), offset: u32, total: u32, data: bytes(16_384) }) },
  unfetch: { id: 0x43, from: 'client', channel: 'reliable', body: struct({ hash: fixedBytes(32) }) },
  notFound: { id: 0x44, from: 'server', channel: 'reliable', body: struct({ hash: fixedBytes(32) }) },
  // Travel (version 3, S2.11): the player walked into a portal; the client asks the core to join
  // that world (the world never hands out a connect token itself) and names the spawn group.
  portal: { id: 0x50, from: 'server', channel: 'reliable', body: struct({ world: uuid, spawn: str(32) }) },
} as const satisfies Record<string, MessageDef>;

/** The connect token's format version, written as its first byte. */
export const TOKEN_VERSION = 0;

/** The token's readable part, also the additional data its encryption authenticates. The nonce
 *  is random per token, so a world server can refuse a token it has already seen. */
export const TOKEN_HEADER = struct({ version: u8, world: uuid, expiresAt: u64, nonce: fixedBytes(12) });

/** What the core vouches for, encrypted for one world (docs/protocol.md, "The connect token").
 *  A minor's birth date never travels: only `under18`. */
export const TOKEN_CLAIMS = struct({
  account: uuid,
  name: str(64),
  trust: uint(3),
  tester: bool,
  emailVerified: bool,
  under18: bool,
  ageDays: u16,
});

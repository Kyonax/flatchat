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
export const PROTOCOL_VERSION = 10;

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

/** A player's height in centimetres (version 4, S2.07): what they chose, fitted by the world into
 *  its range; 0 in a hello means the platform's default. */
const centimetres = uint(10);

/** A player's role in one world (version 5, S3.06), rights growing along the list: a builder may
 *  replace the world's files, a moderator kicks, bans and mutes, an admin also gives roles, and the
 *  owner (the account the core approved the world for, from the connect token) gives any of them.
 *  The world keeps the others in its own database. */
export const ROLES = ['visitor', 'builder', 'moderator', 'admin', 'owner'] as const;
const role = oneOf(ROLES);
/** A face (version 7, S4.07): VRM 1.0's emotions, chosen from a menu or a hotkey, and each hand's
 *  pose. The mouth moves with the voice frames instead. */
export const EXPRESSIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
export const HAND_POSES = ['relaxed', 'fist', 'point', 'peace', 'thumbsUp', 'open', 'rock'] as const;
const face = struct({ expression: oneOf(EXPRESSIONS), left: oneOf(HAND_POSES), right: oneOf(HAND_POSES) });
/** A player's proportions (version 8, S4.10), each in percent of the avatar as made: the
 *  shoulders' and hips' width, the arms' and legs' length and the head's size. The world fits each
 *  into PROPORTIONS; every client moves the avatar's bones by them. */
export const PROPORTIONS = { min: 80, max: 125 } as const;
const proportions = struct({ width: u8, arms: u8, legs: u8, head: u8 });
/** A worn item (version 9, S5.05): its manifest's SHA-256 in the core's store, and for an
 *  attachment the player's adjustment at its point (centimetres, degrees, percent), fitted by the
 *  world to the platform's limits (packages/content's ADJUST_LIMITS). The clothes go on a standard
 *  body by their fits; a prop goes on any avatar at the point its manifest names. */
const worn = struct({ item: fixedBytes(32), adjust: optional(struct({ x: int(8), y: int(8), z: int(8), rx: int(8), ry: int(8), rz: int(8), scale: u8 })) });
/** The most items a player wears at once (version 9). */
export const OUTFIT_MAX = 16;
const outfit = list(worn, OUTFIT_MAX);
/** An emote or a dance playing (version 10, S5.07): its animation manifest's SHA-256 in the core's
 *  store and the world tick it started at, so every client shows it in step. */
const playing = struct({ anim: fixedBytes(32), tick: u32 });

/** One player in the world's roster. `avatar` is the content hash the client fetches from the
 *  core's asset store, never from the host; `height` is the world's fitted height. */
const player = struct({
  entity: u16,
  account: uuid,
  name: str(64),
  trust: uint(3),
  avatar: optional(fixedBytes(32)),
  height: centimetres,
  role,
  face,
  proportions,
  outfit,
  emote: optional(playing),
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

/** What a moderator does to an account in one world (version 5, S3.07); a ban's or mute's
 *  `minutes` of 0 lasts until lifted. */
export const MOD_ACTIONS = ['kick', 'ban', 'unban', 'mute', 'unmute'] as const;

/** Who may reach a player by voice and text (version 5, S3.10): everyone for adults; friends for an
 *  account aged 13 to 17 unless its guardian widened or narrowed it. */
export const CONTACT = ['everyone', 'friends', 'none'] as const;

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
    // `height` (version 4): the player's chosen height, which the world fits into its range.
    // `proportions` (version 8): the avatar's sliders, fitted by the world too; left out, as made.
    body: struct({ protocol: u16, fingerprint: u32, build: str(32), token: bytes(4096), spawn: str(32), height: centimetres, proportions: optional(proportions) }),
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
  // The player's look (version 4, S2.07): a new height; the world fits it and sends a roster change.
  appearance: { id: 0x13, from: 'client', channel: 'reliable', body: struct({ height: centimetres, proportions: optional(proportions) }) },
  // A new avatar during the visit (version 7, S4.05): a fresh connect token for this world, of the
  // same account, whose `avatar` the world takes into the roster; the core vouches for the avatar,
  // so a client cannot wear what it does not own.
  wear: { id: 0x16, from: 'client', channel: 'reliable', body: struct({ token: bytes(4096) }) },
  // The player's face and hands (version 7, S4.07); the world keeps it in the roster.
  face: { id: 0x17, from: 'client', channel: 'reliable', body: face },
  // What the player wears (version 9, S5.05): the world fits it and keeps it in the roster.
  outfit: { id: 0x18, from: 'client', channel: 'reliable', body: struct({ items: outfit }) },
  // An emote or a dance (version 10, S5.07): the animation to play, or none to stop; the world puts
  // it in the roster with the tick it started at.
  emote: { id: 0x19, from: 'client', channel: 'reliable', body: struct({ anim: optional(fixedBytes(32)) }) },
  // A move the client cannot walk (version 4, S2.06): onto a seat (`seat`, its index in the built
  // world), or to a clicked spot. The world checks it and answers `placed`: where the player is
  // now, and whether it moved them.
  teleport: { id: 0x14, from: 'client', channel: 'reliable', body: struct({ position, yaw, seat: optional(u16) }) },
  placed: { id: 0x15, from: 'server', channel: 'reliable', body: struct({ position, yaw, stance, accepted: bool }) },
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
    // `gain` (S3.08): the speaker's loudness as the world sets it (a stage, a plugin), in 64ths: 64
    // is as spoken, 255 nearly four times (the world format's zones go to 4). `range` (version 6):
    // how far, in metres, the world carries this speaker, so the listener's falloff ends there too
    // (0: the platform's 25 m).
    body: struct({ frames: list(struct({ from: u16, seq: u16, start: bool, mouth, gain: u8, range: u8, opus: bytes(255) }), 16) }),
  },
  // World content (version 2, S2.04): the server names its built world by the SHA-256 of its
  // world.json; the client fetches what its cache lacks, file by file, from any offset (resuming
  // after a lost connection), and checks each file's hash before using it.
  content: { id: 0x40, from: 'server', channel: 'reliable', body: struct({ world: fixedBytes(32), size: u32 }) },
  fetch: { id: 0x41, from: 'client', channel: 'reliable', body: struct({ hash: fixedBytes(32), from: u32 }) },
  chunk: { id: 0x42, from: 'server', channel: 'reliable', body: struct({ hash: fixedBytes(32), offset: u32, total: u32, data: bytes(16_384) }) },
  unfetch: { id: 0x43, from: 'client', channel: 'reliable', body: struct({ hash: fixedBytes(32) }) },
  notFound: { id: 0x44, from: 'server', channel: 'reliable', body: struct({ hash: fixedBytes(32) }) },
  // A new build of the world from someone with build rights (version 5, S3.06): its files in
  // pieces, each acknowledged with `got` (how many bytes of that file the world holds, so the sender
  // keeps only a window in flight), then world.json's hash; the world checks the whole build and
  // answers with `published`.
  put: { id: 0x45, from: 'client', channel: 'reliable', body: struct({ hash: fixedBytes(32), offset: u32, total: u32, data: bytes(16_384) }) },
  publish: { id: 0x46, from: 'client', channel: 'reliable', body: struct({ world: fixedBytes(32) }) },
  published: { id: 0x47, from: 'server', channel: 'reliable', body: struct({ ok: bool, detail: str(160) }) },
  got: { id: 0x48, from: 'server', channel: 'reliable', body: struct({ hash: fixedBytes(32), offset: u32 }) },
  // Travel (version 3, S2.11): the player walked into a portal; the client asks the core to join
  // that world (the world never hands out a connect token itself) and names the spawn group.
  portal: { id: 0x50, from: 'server', channel: 'reliable', body: struct({ world: uuid, spawn: str(32) }) },
  // Roles and moderation (version 5, S3.06 and S3.07): what a player asks the world to do to an
  // account, checked against the asker's role; `muted` tells a player a moderator muted them.
  role: { id: 0x60, from: 'client', channel: 'reliable', body: struct({ account: uuid, role }) },
  moderate: { id: 0x61, from: 'client', channel: 'reliable', body: struct({ account: uuid, action: oneOf(MOD_ACTIONS), minutes: u32, reason: str(160) }) },
  muted: { id: 0x62, from: 'server', channel: 'reliable', body: struct({ on: bool, reason: str(160) }) },
  // Blocks (version 5, S3.11): a player blocked or unblocked an account during the visit (the core
  // keeps it); `hidden` lists the entities this player and the world keep apart, both ways.
  block: { id: 0x63, from: 'client', channel: 'reliable', body: struct({ account: uuid, on: bool }) },
  hidden: { id: 0x64, from: 'server', channel: 'reliable', body: struct({ entities: list(u16, 256) }) },
} as const satisfies Record<string, MessageDef>;

/** The connect token's format version, written as its first byte. */
export const TOKEN_VERSION = 2;

/** The token's readable part, also the additional data its encryption authenticates. The nonce
 *  is random per token, so a world server can refuse a token it has already seen. */
export const TOKEN_HEADER = struct({ version: u8, world: uuid, expiresAt: u64, nonce: fixedBytes(12) });

/** What the core vouches for, encrypted for one world (docs/protocol.md, "The connect token").
 *  A minor's birth date never travels: only `under18`. Format 1 (version 5) adds whether the
 *  account owns the world, who may reach it, a minor's accepted friends and the accounts kept apart
 *  from it by a block in either direction, 100 of each at most. Format 2 (version 7) adds the
 *  avatar the account wears: its manifest's SHA-256 in the core's store (S4.05). */
export const TOKEN_CLAIMS = struct({
  account: uuid,
  name: str(64),
  trust: uint(3),
  tester: bool,
  emailVerified: bool,
  under18: bool,
  ageDays: u16,
  owner: bool,
  contact: oneOf(CONTACT),
  friends: list(uuid, 100),
  blocks: list(uuid, 100),
  avatar: optional(fixedBytes(32)),
});

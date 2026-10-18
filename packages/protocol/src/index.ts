// SPDX-License-Identifier: Apache-2.0
// FlatChat's wire protocol, version 0: the message schema, the bit-packed codecs, the connect
// token and the version handshake, shared by the client, the world server, the bots and the core.
// It runs unchanged in Node.js and in the client's sandboxed renderer: Web APIs only. The wire
// format is specified in docs/protocol.md; the golden packets are in '@flatchat/protocol/golden'.
export { BitReader, BitWriter } from './bits.ts';
export {
  angle,
  bool,
  bytes,
  type Codec,
  fixed,
  fixedBytes,
  type Infer,
  int,
  type Json,
  list,
  oneOf,
  optional,
  type Spec,
  str,
  struct,
  type StructValue,
  u16,
  u32,
  u64,
  u8,
  uint,
  uuid,
} from './codec.ts';
export { PROTOCOL_ERROR_CODES, ProtocolError, type ProtocolErrorCode } from './errors.ts';
export { describeSchema, fingerprintHex, fnv1a32, SCHEMA_FINGERPRINT, type SchemaDescription } from './fingerprint.ts';
export { checkVersion, type Refusal, versionPolicy, type VersionPolicy } from './handshake.ts';
export { fromHex, toHex } from './hex.ts';
export {
  type CellBlock,
  decodeCellBlock,
  decodeMessage,
  encodeCellBlock,
  encodeMessage,
  type Message,
  type MessageBody,
  messageDef,
  messageFromJson,
  type MessageName,
  type MessageOf,
  messageToJson,
} from './messages.ts';
export {
  CELL_BLOCK,
  CELL_SIZE,
  type Channel,
  CONTACT,
  EXPRESSIONS,
  HAND_POSES,
  LEAVE_REASONS,
  MAX_MESSAGE_BYTES,
  type MessageDef,
  MESSAGES,
  MOD_ACTIONS,
  position,
  PROPORTIONS,
  PROTOCOL_VERSION,
  REFUSE_REASONS,
  ROLES,
  type Sender,
  STANCES,
  TOKEN_CLAIMS,
  TOKEN_HEADER,
  TOKEN_VERSION,
} from './schema.ts';
export {
  newWorldKey,
  openToken,
  type OpenOptions,
  readTokenHeader,
  sealToken,
  type SealOptions,
  TOKEN_ERROR_CODES,
  TOKEN_HEADER_BYTES,
  TOKEN_NONCE_BYTES,
  TOKEN_TAG_BYTES,
  type TokenClaims,
  TokenError,
  type TokenErrorCode,
  type TokenHeader,
  WORLD_KEY_BYTES,
} from './token.ts';

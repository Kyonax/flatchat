// SPDX-License-Identifier: Apache-2.0
// Encoding and decoding whole messages. A message is its type number (one byte), then its body;
// the decoder refuses anything malformed with a ProtocolError, so nothing a stranger sends reaches
// the rest of the program unchecked.
import { BitReader, BitWriter } from './bits.ts';
import type { Infer, Json } from './codec.ts';
import { ProtocolError } from './errors.ts';
import { CELL_BLOCK, MAX_MESSAGE_BYTES, type MessageDef, MESSAGES, type Sender } from './schema.ts';

export type MessageName = keyof typeof MESSAGES;
export type MessageBody<K extends MessageName> = Infer<(typeof MESSAGES)[K]['body']>;
export type Message = { [K in MessageName]: { type: K } & MessageBody<K> }[MessageName];
export type MessageOf<K extends MessageName> = Extract<Message, { type: K }>;
export type CellBlock = Infer<typeof CELL_BLOCK>;

interface Entry extends MessageDef {
  name: MessageName;
}

const BY_NAME = new Map<string, Entry>();
const BY_ID = new Map<number, Entry>();
for (const [name, def] of Object.entries(MESSAGES) as Array<[MessageName, MessageDef]>) {
  if (def.body.spec.kind !== 'struct' || def.body.spec.fields.some((f) => f.name === 'type')) {
    throw new Error(`message ${name}: the body must be a struct without a field named "type"`);
  }
  if (BY_ID.has(def.id) || def.id < 1 || def.id > 255) throw new Error(`message ${name}: type number ${def.id} is taken or out of range`);
  const entry = { ...def, name };
  BY_NAME.set(name, entry);
  BY_ID.set(def.id, entry);
}

function entryFor(type: unknown): Entry {
  const entry = typeof type === 'string' ? BY_NAME.get(type) : undefined;
  if (!entry) throw new ProtocolError('bad-value', `no message named ${String(type)}`);
  return entry;
}

/** The definition of a message type: its number, sender and channel. */
export function messageDef(type: MessageName): MessageDef {
  return entryFor(type);
}

export function encodeMessage(message: Message): Uint8Array<ArrayBuffer> {
  const entry = entryFor(message.type);
  const w = new BitWriter(64);
  w.writeBits(entry.id, 8);
  entry.body.write(w, message);
  const out = w.finish();
  if (out.length > MAX_MESSAGE_BYTES) throw new ProtocolError('too-long', `${entry.name}: ${out.length} bytes, the limit is ${MAX_MESSAGE_BYTES}`);
  return out;
}

/** Decodes one message. `from` names the side that sent it, so a client cannot send what only a
 *  server may send (and the other way round); leave it out only where both are acceptable. */
export function decodeMessage(bytes: Uint8Array, from?: Exclude<Sender, 'either'>): Message {
  if (bytes.length === 0) throw new ProtocolError('truncated', 'an empty message');
  if (bytes.length > MAX_MESSAGE_BYTES) throw new ProtocolError('too-long', `${bytes.length} bytes, the limit is ${MAX_MESSAGE_BYTES}`);
  const entry = BY_ID.get(bytes[0]!);
  if (!entry) throw new ProtocolError('unknown-type', `type number ${bytes[0]}`);
  if (from !== undefined && entry.from !== 'either' && entry.from !== from) {
    throw new ProtocolError('wrong-direction', `${entry.name} is sent by the ${entry.from}, not the ${from}`);
  }
  const r = new BitReader(bytes);
  r.readBits(8);
  const body = entry.body.read(r) as Record<string, unknown>;
  r.end();
  return { type: entry.name, ...body } as Message;
}

/** The message as JSON: its type and its fields, bytes as hexadecimal. */
export function messageToJson(message: Message): { type: MessageName } & { [key: string]: Json } {
  const entry = entryFor(message.type);
  return { type: entry.name, ...(entry.body.toJson(message) as { [key: string]: Json }) };
}

export function messageFromJson(json: Json): Message {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new ProtocolError('bad-value', 'a message must be an object');
  const { type, ...fields } = json;
  const entry = entryFor(type);
  return { type: entry.name, ...(entry.body.fromJson(fields) as Record<string, unknown>) } as Message;
}

export function encodeCellBlock(block: CellBlock): Uint8Array<ArrayBuffer> {
  const w = new BitWriter(64);
  CELL_BLOCK.write(w, block);
  return w.finish();
}

export function decodeCellBlock(bytes: Uint8Array): CellBlock {
  const r = new BitReader(bytes);
  const block = CELL_BLOCK.read(r);
  r.end();
  return block;
}

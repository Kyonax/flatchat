// SPDX-License-Identifier: Apache-2.0
// The golden packets (golden/*.json): fixed values with the exact bytes every implementation must
// produce for them, sealed tokens, and malformed packets every decoder must refuse with a given
// code. The protocol's own tests, the world server's tests and the client's smoke test (inside the
// bundled renderer, on Linux and on Windows in CI) all run them through runGolden(), so every
// program that links the library proves it reads and writes the same bytes. An implementation in
// another language runs the same files. Import it as '@flatchat/protocol/golden', apart from the
// library, so programs carry the files only where they check them.
import blocksFile from '../golden/blocks.json' with { type: 'json' };
import invalidFile from '../golden/invalid.json' with { type: 'json' };
import messagesFile from '../golden/messages.json' with { type: 'json' };
import schemaFile from '../golden/schema.json' with { type: 'json' };
import tokensFile from '../golden/tokens.json' with { type: 'json' };
import type { Json } from './codec.ts';
import { ProtocolError, type ProtocolErrorCode } from './errors.ts';
import { fingerprintHex } from './fingerprint.ts';
import { fromHex, toHex } from './hex.ts';
import { decodeCellBlock, decodeMessage, encodeCellBlock, encodeMessage, messageFromJson, messageToJson } from './messages.ts';
import { CELL_BLOCK, PROTOCOL_VERSION, TOKEN_CLAIMS } from './schema.ts';
import { openToken, sealToken, TokenError, type TokenErrorCode } from './token.ts';

export interface ValueCase {
  name: string;
  value: Json;
  hex: string;
}

export interface TokenCase {
  name: string;
  key: string;
  world: string;
  expiresAt: number;
  nonce: string;
  claims: Json;
  hex: string;
}

export interface TokenRejectCase {
  name: string;
  key: string;
  world: string;
  now: number;
  hex: string;
  error: TokenErrorCode;
}

export interface InvalidCase {
  name: string;
  kind: 'message' | 'block';
  from: 'client' | 'server' | null;
  hex: string;
  error: ProtocolErrorCode;
}

export interface GoldenFiles {
  schema: { protocol: number; fingerprint: string; schema: Json };
  messages: { cases: ValueCase[] };
  blocks: { cases: ValueCase[] };
  tokens: { cases: TokenCase[]; rejects: TokenRejectCase[] };
  invalid: { cases: InvalidCase[] };
}

export const GOLDEN: GoldenFiles = {
  schema: schemaFile as unknown as GoldenFiles['schema'],
  messages: messagesFile as unknown as GoldenFiles['messages'],
  blocks: blocksFile as unknown as GoldenFiles['blocks'],
  tokens: tokensFile as unknown as GoldenFiles['tokens'],
  invalid: invalidFile as unknown as GoldenFiles['invalid'],
};

/** JSON text with object keys sorted, for comparing values whatever order their keys came in. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The bytes this build writes for a message given as JSON, and what it reads back from them. */
export function messageCase(value: Json): { hex: string; back: Json } {
  const hex = toHex(encodeMessage(messageFromJson(value)));
  return { hex, back: messageToJson(decodeMessage(fromHex(hex))) };
}

export function blockCase(value: Json): { hex: string; back: Json } {
  const hex = toHex(encodeCellBlock(CELL_BLOCK.fromJson(value)));
  return { hex, back: CELL_BLOCK.toJson(decodeCellBlock(fromHex(hex))) };
}

/** The sealed bytes this build writes for a token case, and the claims it opens from them. */
export async function tokenCase(c: Omit<TokenCase, 'hex'>): Promise<{ hex: string; back: Json }> {
  const key = fromHex(c.key);
  const hex = toHex(await sealToken(TOKEN_CLAIMS.fromJson(c.claims), { key, world: c.world, expiresAt: c.expiresAt, nonce: fromHex(c.nonce) }));
  const opened = await openToken(fromHex(hex), { key, world: c.world, now: c.expiresAt - 1 });
  return { hex, back: TOKEN_CLAIMS.toJson(opened.claims) };
}

function checkValue(c: ValueCase, run: (value: Json) => { hex: string; back: Json }): string | undefined {
  try {
    const { hex, back } = run(c.value);
    if (hex !== c.hex) return `writes ${hex}, the golden bytes are ${c.hex}`;
    if (canonicalJson(back) !== canonicalJson(c.value)) return `reads back ${JSON.stringify(back)}`;
    return undefined;
  } catch (err) {
    return `threw ${message(err)}`;
  }
}

async function checkToken(c: TokenCase): Promise<string | undefined> {
  try {
    const { hex, back } = await tokenCase(c);
    if (hex !== c.hex) return `seals to ${hex}, the golden bytes are ${c.hex}`;
    if (canonicalJson(back) !== canonicalJson(c.claims)) return `opens to ${JSON.stringify(back)}`;
    return undefined;
  } catch (err) {
    return `threw ${message(err)}`;
  }
}

async function checkTokenReject(c: TokenRejectCase): Promise<string | undefined> {
  try {
    await openToken(fromHex(c.hex), { key: fromHex(c.key), world: c.world, now: c.now });
    return `was accepted; expected ${c.error}`;
  } catch (err) {
    return err instanceof TokenError && err.code === c.error ? undefined : `threw ${message(err)}; expected ${c.error}`;
  }
}

function checkInvalid(c: InvalidCase): string | undefined {
  try {
    const bytes = fromHex(c.hex);
    if (c.kind === 'block') decodeCellBlock(bytes);
    else decodeMessage(bytes, c.from ?? undefined);
    return `was accepted; expected ${c.error}`;
  } catch (err) {
    return err instanceof ProtocolError && err.code === c.error ? undefined : `threw ${message(err)}; expected ${c.error}`;
  }
}

export interface GoldenReport {
  protocol: number;
  fingerprint: string;
  cases: number;
  failures: string[];
}

/** Runs every golden case through this build of the library. */
export async function runGolden(files: GoldenFiles = GOLDEN): Promise<GoldenReport> {
  const failures: string[] = [];
  let cases = 0;
  const record = (where: string, problem: string | undefined): void => {
    cases += 1;
    if (problem) failures.push(`${where}: ${problem}`);
  };
  record(
    'schema.json',
    files.schema.protocol !== PROTOCOL_VERSION || files.schema.fingerprint !== fingerprintHex()
      ? `records version ${files.schema.protocol} with schema ${files.schema.fingerprint}; this build is version ${PROTOCOL_VERSION} with schema ${fingerprintHex()}`
      : undefined,
  );
  for (const c of files.messages.cases) record(`messages.json ${c.name}`, checkValue(c, messageCase));
  for (const c of files.blocks.cases) record(`blocks.json ${c.name}`, checkValue(c, blockCase));
  for (const c of files.tokens.cases) record(`tokens.json ${c.name}`, await checkToken(c));
  for (const c of files.tokens.rejects) record(`tokens.json ${c.name}`, await checkTokenReject(c));
  for (const c of files.invalid.cases) record(`invalid.json ${c.name}`, checkInvalid(c));
  return { protocol: PROTOCOL_VERSION, fingerprint: fingerprintHex(), cases, failures };
}

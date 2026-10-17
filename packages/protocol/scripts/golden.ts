// SPDX-License-Identifier: Apache-2.0
// The golden writer: fills in the bytes of every golden case from this build of the library, and
// writes golden/schema.json. It refuses to record new bytes for a protocol version that already
// has golden bytes: when the schema or the encoding changes, PROTOCOL_VERSION goes up first.
//
//   npm run golden -w @flatchat/protocol              check: exit 1 if the files are out of date
//   npm run golden -w @flatchat/protocol -- --write   write them
//
// Cases are added by hand: a value without "hex" (messages.json, blocks.json, tokens.json), or a
// malformed packet (invalid.json, tokens.json "rejects") given as hex or as a change to another
// case: "truncate" (keep N bytes), "append" (hex to add), "xor" ([byte index, mask]; a negative
// index counts from the end).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, blockCase, type GoldenFiles, messageCase, runGolden, tokenCase } from '../src/golden.ts';
import { describeSchema, fingerprintHex, fromHex, type Json, PROTOCOL_VERSION, toHex } from '../src/index.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');
const FILES = ['schema', 'messages', 'blocks', 'tokens', 'invalid'] as const;

interface Mutation {
  base?: string;
  truncate?: number;
  append?: string;
  xor?: [number, number];
}

function mutate(bytes: Uint8Array, m: Mutation): Uint8Array {
  let out = bytes.slice();
  if (m.truncate !== undefined) out = out.slice(0, m.truncate);
  if (m.append !== undefined) {
    const extra = fromHex(m.append);
    const joined = new Uint8Array(out.length + extra.length);
    joined.set(out);
    joined.set(extra, out.length);
    out = joined;
  }
  if (m.xor !== undefined) {
    const [at, mask] = m.xor;
    const i = at < 0 ? out.length + at : at;
    if (i < 0 || i >= out.length) throw new Error(`xor: byte ${at} is outside ${out.length} bytes`);
    out[i] = (out[i] ?? 0) ^ mask;
  }
  return out;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { write: { type: 'boolean' } } });
  const files = Object.fromEntries(FILES.map((f) => [f, JSON.parse(readFileSync(join(DIR, `${f}.json`), 'utf8')) as unknown])) as unknown as GoldenFiles;
  const problems: string[] = [];
  const changed: string[] = [];
  const wireChanged: string[] = [];

  const fill = (where: string, c: { hex?: string }, hex: string): void => {
    if (c.hex === hex) return;
    if (c.hex) wireChanged.push(where);
    changed.push(where);
    c.hex = hex;
  };
  const sameJson = (a: Json, b: Json): boolean => canonicalJson(a) === canonicalJson(b);

  for (const [label, cases, run] of [
    ['messages.json', files.messages.cases, messageCase],
    ['blocks.json', files.blocks.cases, blockCase],
  ] as const) {
    for (const c of cases) {
      try {
        const { hex, back } = run(c.value);
        if (!sameJson(back, c.value)) problems.push(`${label} ${c.name}: reads back ${JSON.stringify(back)}; give values the fields hold exactly`);
        else fill(`${label} ${c.name}`, c, hex);
      } catch (err) {
        problems.push(`${label} ${c.name}: ${(err as Error).message}`);
      }
    }
  }
  for (const c of files.tokens.cases) {
    try {
      const { hex, back } = await tokenCase(c);
      if (!sameJson(back, c.claims)) problems.push(`tokens.json ${c.name}: opens to ${JSON.stringify(back)}`);
      else fill(`tokens.json ${c.name}`, c, hex);
    } catch (err) {
      problems.push(`tokens.json ${c.name}: ${(err as Error).message}`);
    }
  }

  // Malformed cases built from another case: recompute their bytes from it.
  const sources: Record<string, Array<{ name: string; hex?: string }>> = {
    message: files.messages.cases,
    block: files.blocks.cases,
    token: files.tokens.cases,
  };
  const derive = (label: string, c: Mutation & { name: string; hex?: string }, kind: string): void => {
    if (c.base === undefined) return;
    const base = sources[kind]?.find((b) => b.name === c.base);
    if (!base?.hex) {
      problems.push(`${label} ${c.name}: no ${kind} case named ${c.base} with bytes`);
      return;
    }
    try {
      const hex = toHex(mutate(fromHex(base.hex), c));
      if (c.hex !== hex) changed.push(`${label} ${c.name}`);
      c.hex = hex;
    } catch (err) {
      problems.push(`${label} ${c.name}: ${(err as Error).message}`);
    }
  };
  for (const c of files.tokens.rejects) derive('tokens.json', c as Mutation & typeof c, 'token');
  for (const c of files.invalid.cases) derive('invalid.json', c as Mutation & typeof c, c.kind);

  const schema = { protocol: PROTOCOL_VERSION, fingerprint: fingerprintHex(), schema: describeSchema() as unknown as Json };
  const old = files.schema;
  if (!sameJson(old as unknown as Json, schema as unknown as Json)) changed.push('schema.json');
  if (old.protocol > PROTOCOL_VERSION) problems.push(`schema.json records version ${old.protocol}; this build is ${PROTOCOL_VERSION}: versions only go up`);
  if (old.protocol === PROTOCOL_VERSION && (old.fingerprint !== schema.fingerprint || wireChanged.length > 0)) {
    const what = old.fingerprint !== schema.fingerprint ? [`the schema (${old.fingerprint} → ${schema.fingerprint})`] : [];
    problems.push(
      `version ${PROTOCOL_VERSION} already has golden bytes, and this build changes ${[...what, ...wireChanged].join(', ')}: ` +
        'raise PROTOCOL_VERSION in packages/protocol/src/schema.ts, then run this again (docs/protocol.md, "Changing the protocol")',
    );
  }
  files.schema = schema;

  // Every case must pass as the files will hold it, the malformed ones refused with their codes.
  if (problems.length === 0) problems.push(...(await runGolden(files)).failures);
  if (problems.length > 0) {
    console.error(`golden: ${problems.length} problem(s), nothing written`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  if (changed.length === 0) {
    console.log(`golden: up to date · version ${PROTOCOL_VERSION} · schema ${schema.fingerprint}`);
    return 0;
  }
  if (!values.write) {
    console.error(`golden: out of date (${changed.join(', ')}); run npm run golden -w @flatchat/protocol -- --write`);
    return 1;
  }
  for (const f of FILES) writeFileSync(join(DIR, `${f}.json`), `${JSON.stringify(files[f], null, 2)}\n`);
  console.log(`golden: wrote ${changed.join(', ')} · version ${PROTOCOL_VERSION} · schema ${schema.fingerprint}`);
  return 0;
}

process.exitCode = await main();

// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson, GOLDEN, runGolden } from '../src/golden.ts';
import { describeSchema, fingerprintHex, type Json, MESSAGES, PROTOCOL_VERSION } from '../src/index.ts';

const DOC = fileURLToPath(new URL('../../../docs/protocol.md', import.meta.url));
const WRITER = fileURLToPath(new URL('../scripts/golden.ts', import.meta.url));

describe('the golden packets', () => {
  it('all pass on this build', async () => {
    const report = await runGolden();
    expect(report.failures).toEqual([]);
    expect(report.cases).toBeGreaterThanOrEqual(40);
    expect(report).toMatchObject({ protocol: PROTOCOL_VERSION, fingerprint: fingerprintHex() });
  });

  it('record the whole schema of this version', () => {
    expect(canonicalJson(GOLDEN.schema.schema)).toBe(canonicalJson(describeSchema() as unknown as Json));
  });

  it('are up to date, derived cases included', () => {
    const run = spawnSync(process.execPath, [WRITER], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('report a changed byte as a failure', async () => {
    const files = structuredClone(GOLDEN);
    const ping = files.messages.cases.find((c) => c.name === 'ping')!;
    ping.hex = `${ping.hex.slice(0, -2)}00`;
    const report = await runGolden(files);
    expect(report.failures).toEqual([expect.stringContaining('messages.json ping: writes')]);
  });
});

describe('docs/protocol.md', () => {
  it('lists every message with its number, sender, channel and fields', () => {
    const rows = new Map(
      readFileSync(DOC, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('| `'))
        .map((l) => l.split('|').map((cell) => cell.trim()))
        .map((cells) => [cells[1]?.replaceAll('`', ''), cells] as const),
    );
    for (const [name, def] of Object.entries(MESSAGES)) {
      const fields = def.body.spec.kind === 'struct' ? def.body.spec.fields.map((f) => f.name).join(', ') : '';
      const id = `0x${def.id.toString(16).padStart(2, '0')}`;
      expect(rows.get(name)?.slice(2, 6), name).toEqual([id, def.from, def.channel, fields]);
    }
  });
});

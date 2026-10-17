// SPDX-License-Identifier: MPL-2.0
// The protocol as this server links it: every golden packet, read and written through the
// workspace package the server imports.
import { runGolden } from '@flatchat/protocol/golden';
import { describe, expect, it } from 'vitest';

describe('the protocol the world server links', () => {
  it('passes every golden packet', async () => {
    const report = await runGolden();
    expect(report.failures).toEqual([]);
    expect(report.cases).toBeGreaterThan(0);
  });
});

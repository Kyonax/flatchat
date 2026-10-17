// SPDX-License-Identifier: MPL-2.0
// The smoke test's protocol check: every golden packet, read and written by the protocol library
// as this renderer bundled it, so CI proves the packaged client speaks the same bytes as the world
// server, on Linux and on Windows. Imported only in smoke mode, so it loads as its own chunk.
export interface ProtocolCheck {
  protocol?: number;
  fingerprint?: string;
  cases: number;
  failures: string[];
  error?: string;
}

export async function checkProtocol(): Promise<ProtocolCheck> {
  try {
    const { runGolden } = await import('@flatchat/protocol/golden');
    return await runGolden();
  } catch (err) {
    return { cases: 0, failures: [], error: err instanceof Error ? err.message : String(err) };
  }
}

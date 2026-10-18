// SPDX-License-Identifier: MPL-2.0
// The dry run's worker thread (dry-run.ts's DryRunner): measures the effects it is sent, one at a
// time, and answers each with its measurement or why it failed.
import { parentPort } from 'node:worker_threads';
import { dryRun } from './dry-run.ts';
import type { DryRunOptions } from '@flatchat/effects';

parentPort!.on('message', (m: { id: number; main: string; files: Array<[string, Uint8Array]>; o: DryRunOptions }) => {
  dryRun({ main: m.main, files: new Map(m.files) }, m.o).then(
    (result) => parentPort!.postMessage({ id: m.id, ok: true, result }),
    (err: unknown) => parentPort!.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

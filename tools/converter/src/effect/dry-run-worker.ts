// SPDX-License-Identifier: MPL-2.0
// The dry run's worker thread (dry-run.ts's DryRunner): measures the effects it is sent, one at a
// time, and answers each with its measurement or why it failed. Started by the runner, or bundled
// into the client's main process for offline worlds (the package exports it as ./dry-run-worker).
import { parentPort, workerData } from 'node:worker_threads';
import { type DryRunOptions, measure } from '@flatchat/effects';
import { webglBuild } from './dry-run.ts';

// The runtime's WebAssembly when the runner was given it (a bundled main process), else the package's.
const wasm = (workerData as { wasm?: Uint8Array } | null)?.wasm;

parentPort!.on('message', (m: { id: number; main: string; files: Array<[string, Uint8Array]>; o: DryRunOptions }) => {
  webglBuild(wasm).then((build) => measure(build, { main: m.main, files: new Map(m.files) }, m.o)).then(
    (result) => parentPort!.postMessage({ id: m.id, ok: true, result }),
    (err: unknown) => parentPort!.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

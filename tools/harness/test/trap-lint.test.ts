// SPDX-License-Identifier: MPL-2.0
// Every trap is planted once in an inline source and must be found; the clean versions must pass.
// Strings and comments that merely mention a trap must not match.
import { describe, expect, it } from 'vitest';
import { lintSources, TRAPS, type Source } from '../src/trap-lint.ts';

const traps = (...sources: Source[]): string[] => lintSources(sources).map((f) => f.trap);
const main = (text: string): Source => ({ rel: 'apps/client/src/main/index.ts', text: `${text}\nMenu.setApplicationMenu(null);` });

describe('Electron window settings', () => {
  it('finds T01–T04 inside webPreferences', () => {
    const text = `new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, enableBlinkFeatures: 'x' } });`;
    expect(traps(main(text)).sort()).toEqual(['T01', 'T02', 'T03', 'T04', 'T04']);
  });

  it('passes the locked-down settings', () => {
    const text = `new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true, nodeIntegration: false, sandbox: true } });`;
    expect(traps(main(text))).toEqual([]);
  });

  it('needs the default menu removed (T10)', () => {
    const src = { rel: 'apps/client/src/main/index.ts', text: 'const w = new BrowserWindow({});' };
    expect(traps(src)).toEqual(['T10']);
  });
});

describe('untrusted input', () => {
  it('finds code built from strings (T05)', () => {
    const src = { rel: 'apps/world-server/src/x.ts', text: `eval(a); new Function(b); setTimeout('go()', 5); Function(c);` };
    expect(traps(src)).toEqual(['T05', 'T05', 'T05', 'T05']);
  });

  it('finds HTML built from data (T06), in code and in Vue templates', () => {
    const code = { rel: 'apps/client/src/renderer/src/chat.ts', text: `el.innerHTML = msg; el.insertAdjacentHTML('beforeend', msg); document.write(msg);` };
    const vue = { rel: 'apps/client/src/renderer/src/Chat.vue', text: '<script setup lang="ts">\nconst msg = 1;\n</script>\n<template>\n  <p v-html="msg" />\n</template>\n' };
    const found = lintSources([code, vue]);
    expect(found.map((f) => f.trap)).toEqual(['T06', 'T06', 'T06', 'T06']);
    expect(found.find((f) => f.file.endsWith('.vue'))?.line).toBe(5);
  });

  it('finds raw loaders in the client (T11), node:vm (T12) and exec (T13)', () => {
    const loader = { rel: 'apps/client/src/renderer/src/a.ts', text: `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';` };
    const converter = { rel: 'tools/converter/src/a.ts', text: `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';` };
    const vm = { rel: 'apps/world-server/src/plugins.ts', text: `import vm from 'node:vm';` };
    const exec = { rel: 'tools/bots/src/a.ts', text: `import { exec } from 'node:child_process';\nimport * as cp from 'child_process';\ncp.execSync('ls');` };
    expect(traps(loader)).toEqual(['T11']);
    expect(traps(converter)).toEqual([]);
    expect(traps(vm)).toEqual(['T12']);
    expect(traps(exec)).toEqual(['T13', 'T13']);
  });

  it('ignores strings and comments that only mention a trap', () => {
    const src = { rel: 'apps/world-server/src/x.ts', text: `// eval(a) is never called\nconst s = "el.innerHTML = x; nodeIntegration: true";` };
    expect(traps(src)).toEqual([]);
  });

  it('honours an allow comment with a reason', () => {
    const src = { rel: 'apps/world-server/src/x.ts', text: `// trap-lint: allow T05 because the test needs it\neval(a);` };
    expect(traps(src)).toEqual([]);
  });
});

describe('the renderer', () => {
  it('rejects Electron and Node.js imports (T08) but not type-only ones', () => {
    const src = { rel: 'apps/client/src/renderer/src/a.ts', text: `import { ipcRenderer } from 'electron';\nimport { readFileSync } from 'node:fs';\nimport type { IpcRenderer } from 'electron';` };
    expect(traps(src)).toEqual(['T08', 'T08']);
  });

  it('needs a strict content security policy (T07)', () => {
    const page = (csp: string): Source => ({ rel: 'apps/client/src/renderer/index.html', text: `<head>${csp}</head>` });
    expect(traps(page(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'" />`))).toEqual([]);
    expect(traps(page(`<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-eval'" />`))).toEqual(['T07']);
    expect(traps(page('<meta charset="UTF-8" />'))).toEqual(['T07']);
  });

  it('keeps raw IPC out of the page (T09)', () => {
    const bad = { rel: 'apps/client/src/preload/index.ts', text: `contextBridge.exposeInMainWorld('x', { ipcRenderer, send: (c) => ipcRenderer.send(c) });` };
    const good = { rel: 'apps/client/src/preload/index.ts', text: `contextBridge.exposeInMainWorld('x', { report: (r) => ipcRenderer.invoke('app:report', r) });` };
    expect(traps(bad)).toEqual(['T09', 'T09']);
    expect(traps(good)).toEqual([]);
  });

  it('warns on unchecked external links (T16)', () => {
    expect(traps(main('shell.openExternal(url);'))).toEqual(['T16']);
    expect(traps(main("shell.openExternal('https://example.org/help');"))).toEqual([]);
  });
});

describe('the shared packages', () => {
  it('reject Node.js imports and globals (T17) but not type-only imports', () => {
    const src = {
      rel: 'packages/protocol/src/a.ts',
      text: `import { readFileSync } from 'node:fs';\nimport type { Stats } from 'node:fs';\nconst b = Buffer.from('x');\nconst e = process.env['X'];\nf(__dirname);`,
    };
    expect(traps(src)).toEqual(['T17', 'T17', 'T17', 'T17']);
  });

  it('allow Node.js in their scripts and tests, and property names that match', () => {
    const script = { rel: 'packages/protocol/scripts/golden.ts', text: `import { readFileSync } from 'node:fs';\nconsole.log(process.argv);` };
    const test = { rel: 'packages/protocol/test/a.test.ts', text: `import { spawnSync } from 'node:child_process';` };
    const names = { rel: 'packages/protocol/src/b.ts', text: `const o = { process: 1, Buffer: 2 };\nconst v = o.process + o.Buffer;` };
    expect(traps(script, test, names)).toEqual([]);
  });
});

describe('CI workflows', () => {
  const wf = (text: string): Source => ({ rel: '.github/workflows/ci.yml', text });
  const good = `jobs:
  client-linux:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
      - run: xvfb-run -a release/flatchat --smoke --enable-unsafe-swiftshader
      - run: xvfb-run -a release/flatchat --smoke --disable-gpu || true
`;

  it('passes a job with a time limit and a smoke test that can draw', () => {
    expect(traps(wf(good))).toEqual([]);
  });

  it('finds a missing time limit (T14) and a smoke test that cannot draw (T15)', () => {
    const bad = `jobs:
  client-linux:
    runs-on: ubuntu-24.04
    steps:
      - run: xvfb-run -a release/flatchat --smoke
`;
    expect(traps(wf(bad))).toEqual(['T14', 'T15', 'T15']);
  });
});

describe('the trap table', () => {
  it('gives every trap a rule, a title and a fix', () => {
    for (const [id, t] of Object.entries(TRAPS)) {
      expect(id).toMatch(/^T\d\d$/);
      expect(t.rule).toMatch(/^[a-z-]+$/);
      expect(t.title.length).toBeGreaterThan(5);
      expect(t.fix.length).toBeGreaterThan(10);
    }
  });
});

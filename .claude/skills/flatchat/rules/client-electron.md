---
title: The Electron Client — Process Split, Locked-Down Window, Preload Bridge, CSP, Menu and the Smoke and Bench Modes
impact: CRITICAL
impactDescription: The client loads content made by strangers, so one loosened window setting, a page that can reach Node.js or Electron, raw IPC handed to the page or a missing content security policy turns a bad world or chat message into code running on the player's PC; the trap linter fails CI on each of these (T01–T04, T07–T10, T16).
tags: electron, client, main process, preload, renderer, contextBridge, ipcMain, ipcRenderer, ipc, channel, webPreferences, contextIsolation, nodeIntegration, sandbox, webSecurity, csp, content security policy, menu, setApplicationMenu, alt key, smoke, smoke test, bench, benchmark, --smoke, --smoke-out, --bench, --bench-out, --bench-size, flags, exit code, shell.openExternal, electron-vite, ELECTRON_RENDERER_URL, BrowserWindow, security, T01, T02, T03, T04, T07, T08, T09, T10, T16
---

This rule governs `apps/client`: how its three processes divide the work, the window settings that keep a web page from reaching the operating system, the one bridge between them, and the two measuring modes (smoke and bench) that tests, CI and the weak-laptop stand-in drive. The client will render worlds, avatars and chat that other people made; Electron's security model only holds when every setting below stays as it is. The trap linter (`npm run lint:traps`) checks the settings marked with a trap id.

## The Three Parts

| Part | Folder | Runs | May use | Built by |
|---|---|---|---|---|
| Main process | `src/main/` | Node.js with Electron's main APIs | `app`, `BrowserWindow`, `ipcMain`, `Menu`, `node:fs` | electron-vite → `out/main/index.js` |
| Preload | `src/preload/` | Before the page, in an isolated world, sandboxed | `contextBridge`, `ipcRenderer` (only named channels) | → `out/preload/index.js` |
| Renderer | `src/renderer/` | A sandboxed web page: Vue 3.5 and three.js | Web APIs and `window.flatchat` only | → `out/renderer/` |

`src/main/flags.ts` holds the command-line parsing with no Electron import, so its tests run in plain Node; keep logic that can be pure in modules like it.

## The Window Settings (Never Loosen)

| Setting | Value | Trap | What loosening it allows |
|---|---|---|---|
| `contextIsolation` | `true` | T02 | Page scripts reach the preload's objects, and through them Electron |
| `nodeIntegration` (and `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames`) | `false` | T01 | Page scripts call `require` and Node.js directly |
| `sandbox` | `true` | T03 | The renderer process runs without Chromium's OS sandbox |
| `webSecurity` | default `true`, never `false` | T04 | Same-origin checks off; any site's data readable |
| `allowRunningInsecureContent`, `experimentalFeatures`, `enableBlinkFeatures` | never set | T04 | Mixed content and unreviewed web features |
| `preload` | `join(__dirname, '../preload/index.js')` | — | The only way the page gets anything from the main process |

The window opens at 1280×720 with `backgroundColor: '#101014'` and title `FlatChat`. In development (`ELECTRON_RENDERER_URL` set by electron-vite) it loads that URL; otherwise `out/renderer/index.html` through `loadFile`, with the mode in the query string.

## The Bridge (Preload) and IPC

The preload exposes one object, `window.flatchat`, with one named function per channel. Today:

| Function | Channel (`ipcMain.handle`) | Purpose |
|---|---|---|
| `versions` | — (a plain object) | Electron, Chromium and Node versions for the HUD |
| `smokeReport(report)` | `flatchat:smoke-report` | The smoke mode's single report |
| `benchReport(report)` | `flatchat:bench-report` | The bench mode's report with every frame time |

Rules: channel names are string literals of the form `flatchat:<noun>-<verb or noun>`; the renderer's typing lives in `src/renderer/src/env.d.ts` (`interface FlatchatBridge`); the main process validates anything it acts on (reports are only written to a file). Never expose `ipcRenderer` itself or a function that takes the channel name (T09). The renderer never imports `electron` or a Node.js built-in (T08); type-only imports are fine.

## The Page's Content Security Policy

`src/renderer/index.html` carries:
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
```
Scripts come only from the app itself: no `'unsafe-eval'`, no `'unsafe-inline'` for scripts (T07). Vue's single-file components compile ahead of time, so the runtime never needs `eval`. Widen `img-src`, `connect-src` or `media-src` only for a named origin when a feature needs it (for example the asset CDN), never with `*`.

## The Menu

Outside development the main process calls `Menu.setApplicationMenu(null)` before creating the window (T10): Electron's default File/Edit menu appears on Windows and Linux, and its Alt toggle fights the game's controls. Development keeps the menu for reload and DevTools.

## External Links

`shell.openExternal` opens the system browser with whatever URL it gets. Pass it only URLs built in code, or checked against an allow-list of `https:` hosts (T16 warns on anything else).

## The Measuring Modes

| Flag | Meaning |
|---|---|
| `--smoke` | Draw the scene for about 3 s, then report once and quit |
| `--smoke-out=FILE` | Also write the smoke report (one JSON line) to FILE |
| `--bench=SECONDS` | Bench: draw a fixed-size frame with no frame-rate cap; after a 2 s warm-up, log every frame time for SECONDS (1–3600) |
| `--bench-out=FILE` | Write the full bench report, every frame time included |
| `--bench-size=WxH` | The drawing buffer (default `1280x720`; 64–7680 by 64–4320) |

`--smoke` and `--bench` cannot run together; a bad value prints `{"event":"error","errors":[…]}` and exits 2. In bench mode the main process appends Chromium's `disable-frame-rate-limit` and `disable-gpu-vsync` switches before `app` is ready, so frame times show the work, not the display's refresh.

Each mode prints one JSON line to stdout: `event` (`smoke`, `bench`, or `smoke-timeout` / `bench-timeout`), the renderer's report (`backend`, `adapter`, `fps` or `summary`, `width`, `height`), Chromium's `gpu` feature status and the `platform`. The bench line leaves out `frameTimesMs`; the file has it. **Exit code:** 0 only when `backend` is `WebGPU` or `WebGL2`; a scene that could not start reports `backend: 'none'` and exits 1; no report within 30 s (smoke) or SECONDS + 60 s (bench) exits 1. This is what makes a GPU-less machine that draws nothing fail its smoke test instead of passing it.

| Command | What it does |
|---|---|
| `npm run client` | Development, with live reload |
| `npm run client:smoke` | `electron-vite build` then `electron . --smoke` |
| `npm run bench -w @flatchat/client` | Build, then a 10 s bench into `apps/client/out/bench.json` |
| `apps/client/release/linux-unpacked/flatchat --smoke --smoke-out=smoke.json` | The packaged build, as CI runs it |

## Correct vs. Incorrect

**Incorrect:** turning on Node.js in the page to read a file.
```ts
new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
```
**Correct:** read it in the main process and hand the page the result through one named channel.
```ts
// main
ipcMain.handle('flatchat:settings-read', () => readSettings());
// preload
contextBridge.exposeInMainWorld('flatchat', { readSettings: () => ipcRenderer.invoke('flatchat:settings-read') });
```
**Why:** with T01 and T02 loosened, any script that reaches the page (a crafted chat message, a world's text) runs with the player's file system.

**Incorrect:** a generic bridge.
```ts
contextBridge.exposeInMainWorld('ipc', { send: (channel: string, data: unknown) => ipcRenderer.send(channel, data) });
```
**Correct:** one function per channel, with the channel as a literal.
```ts
contextBridge.exposeInMainWorld('flatchat', { benchReport: (r: unknown) => ipcRenderer.invoke('flatchat:bench-report', r) });
```
**Why:** a channel chosen by the page lets page scripts call every handler the main process ever registers (T09).

**Incorrect:** importing Electron in a renderer module.
```ts
import { ipcRenderer } from 'electron';
```
**Correct:** call `window.flatchat.<function>()`, typed in `env.d.ts`.
**Why:** the sandboxed renderer has no `require`; the import either fails at run time or tempts someone to loosen T01–T03 (T08).

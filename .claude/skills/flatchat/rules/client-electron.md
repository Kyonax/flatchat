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
| `signal(url, offer)` | `flatchat:signal` | WebRTC signaling: the main process checks the URL (`signalTarget`), posts the offer and returns the answer |
| `smokeReport(report)` | `flatchat:smoke-report` | The smoke mode's single report |
| `benchReport(report)` | `flatchat:bench-report` | The bench mode's report with every frame time |

Rules: channel names are string literals of the form `flatchat:<noun>-<verb or noun>`; the renderer's typing lives in `src/renderer/src/env.d.ts` (`interface FlatchatBridge`); the main process validates anything it acts on (reports are only written to a file). Never expose `ipcRenderer` itself or a function that takes the channel name (T09). The renderer never imports `electron` or a Node.js built-in (T08); type-only imports are fine.

## The Page's Content Security Policy

`src/renderer/index.html` carries:
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
```
The policy also has `connect-src 'self' blob: flatchat-avatar:` and `img-src 'self' data: blob:`: the crowd bench fetches avatars from its read-only scheme, and GLTFLoader fetches a model's embedded images as blob URLs.

Scripts come only from the app itself: no `'unsafe-eval'`, no `'unsafe-inline'` for scripts (T07). `'wasm-unsafe-eval'` lets the page compile WebAssembly (the voice chain's Opus codec, libopus-wasm, which ships inside the app) and nothing else: it does not allow `eval` or `new Function`, and T07 tells the two apart. Vue's single-file components compile ahead of time, so the runtime never needs `eval`. Widen `img-src`, `connect-src` or `media-src` only for a named origin when a feature needs it (for example the asset CDN), never with `*`. The page has no `connect-src` beyond itself: WebRTC signaling goes through the main process (`signal()` on the bridge, `src/main/signal.ts`), which allows only http(s) URLs at `/rtc` on 127.0.0.1, an RFC 1918 address or a private overlay network's 100.64.0.0/10 (Tailscale) in Stage 0 (`signalTarget`, tested). Permissions: `lockPermissions()` refuses every permission request except audio capture in the voice lounge (Electron grants everything when no handler is set). WebRTC connections themselves are not governed by the CSP.

## The Menu

Outside development the main process calls `Menu.setApplicationMenu(null)` before creating the window (T10): Electron's default File/Edit menu appears on Windows and Linux, and its Alt toggle fights the game's controls. Development keeps the menu for reload and DevTools.

## External Links

`shell.openExternal` opens the system browser with whatever URL it gets. Pass it only URLs built in code, or checked against an allow-list of `https:` hosts (T16 warns on anything else).

## The Measuring Modes

| Flag | Meaning |
|---|---|
| `--smoke` | Draw the scene for about 3 s, then report once and quit |
| `--smoke-out=FILE` | Also write the smoke report (one JSON line) to FILE |
| `--voice-test=SECONDS` with `--join`, `--join-token`, `--listen-token` [`--voice-out=FILE`] | Spike S0.08: join twice and measure the voice chain end to end (`voice-chain`); exits 0 when 90 % of the bursts were heard |
| `--voice-load=SECONDS` [`--voice-out=FILE`] | Spike S0.08: 16 voices through the hearing chain with no network; the report adds each process's CPU from `app.getAppMetrics()` |
| `--census` [`--census-out=FILE`] | Spike S0.10: the network census in the main process (`src/main/census/`) and the GPU from `app.getGPUInfo('complete')`; one JSON line, then quit, with no window. Every probe only asks: two public STUN servers from one socket (the NAT's mapping), STUN over IPv6, UPnP's GetExternalIPAddress (only a LAN description URL is fetched), NAT-PMP and PCP to the gateway; the report keeps derived facts and the ISP's name from reverse DNS, never the public address |
| `--join=http://ADDRESS:PORT/rtc` with `--join-token=HEX` | Smoke or voice-test mode only, this machine or the local network only (the signaling bridge's own rule, `signalTarget`): also join that world server over WebRTC data channels (`src/renderer/src/net-check.ts`: Chromium's RTCPeerConnection, the two pre-negotiated channels, hello, the spawn, one acknowledged pose); `npm run bots -- client-check -- …` supplies both |
| `--bench=SECONDS` | Bench: draw a fixed-size frame with no frame-rate cap; after a 2 s warm-up, log every frame time for SECONDS (1–3600) |
| `--crowd=SECONDS --avatars=DIR` [`--crowd-full`, `--crowd-lod`, `--crowd-present`, `--crowd-springs`, `--crowd-swap`, `--crowd-texture-mb`, `--crowd-lod-ratio`, `--crowd-merge`, `--crowd-headroom`, `--crowd-out`, `--crowd-shot`] | Spike S0.09's crowd bench (`avatars-and-crowds`): runs alone; the main process serves DIR read-only as `flatchat-avatar://bench/` (registered before ready, served before the window opens), samples every process's memory each second, judges the pass lines and can save a PNG of the window (`capturePage`). Exit 0 when it drew and finished |
| `--bench-out=FILE` | Write the full bench report, every frame time included |
| `--bench-size=WxH` | The drawing buffer (default `1280x720`; 64–7680 by 64–4320) |

`--smoke` and `--bench` cannot run together; a bad value prints `{"event":"error","errors":[…]}` and exits 2. In bench mode the main process appends Chromium's `disable-frame-rate-limit` and `disable-gpu-vsync` switches before `app` is ready, so frame times show the work, not the display's refresh.

Each mode prints one JSON line to stdout: `event` (`smoke`, `bench`, or `smoke-timeout` / `bench-timeout`), the renderer's report (`backend`, `adapter`, `fps` or `summary`, `width`, `height`), Chromium's `gpu` feature status and the `platform`. The bench line leaves out `frameTimesMs`; the file has it. The smoke report also carries `protocol` (`protocol`, `fingerprint`, `cases`, `failures`): in smoke mode the renderer loads `@flatchat/protocol/golden` as its own chunk (`src/renderer/src/protocol-check.ts`) and runs every golden packet through the library as Vite bundled it, so CI proves the packaged client speaks the server's bytes on Linux and Windows. With `--join` the report also carries `net` (`ok`, `joinMs`, `entity`, `snapshots`, `error`). **Exit code:** 0 only when `backend` is `WebGPU` or `WebGL2`, and, for a smoke run, every golden packet passed and any join asked for worked (`exitCodeFor(report, mode, { join })` in `flags.ts`); a scene that could not start reports `backend: 'none'` and exits 1; no report within 30 s (smoke) or SECONDS + 60 s (bench) exits 1. This is what makes a GPU-less machine that draws nothing, or a bundle that misreads the protocol, fail its smoke test instead of passing it.

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

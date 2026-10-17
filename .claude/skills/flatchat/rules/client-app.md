---
title: The Client App — Sign-in Through the System Browser, Settings and Key Bindings, Two Languages, the World View, Chat, Voice and the End-to-End Test
impact: HIGH
impactDescription: An account token in the page, a sign-in that can be polled, a refresh raced by two calls, a word the Spanish screen lacks, a key the player cannot rebind, a joining player drawn as someone else, or a style leaking from a spike screen each break the first thing a tester sees.
tags: client app, ClientApp, SignIn, HomeView, WorldRow, world browser, favourites, join by ID, SettingsView, WorldView, MicQuestion, vue-i18n, i18n, en, es, translation, no-bare-strings-in-template, settings, settings.json, key bindings, remap, KeyboardEvent.code, Controls, pointer lock, mouse look, Remotes, interpolation, camera, third person, first person, CrowdView, instanced, name tags, canvas text, WorldSession, chat, portal, travel, goThrough, push to talk, open microphone, mute, safeStorage, refresh token, auth, core-api, loopback, PKCE, --core, DEFAULT_CORE, e2e, Playwright, playwright-core, _electron
---

With no mode flag the client is the app (S1.04, S1.09–S1.11): it signs in through the system browser, lists the core's approved worlds, joins one, and puts the player on the plaza with chat and proximity voice. The measuring modes (`--smoke`, `--bench`, `--crowd`, the voice tests, the lounge, the census) are untouched; `App.vue` picks `ClientApp` only when none is in the query.

## The Files

| File | Job |
|---|---|
| `src/main/core-api.ts` | `CoreApi` over `fetch` (injected in tests): login requests, the code exchange, refresh, sign-out, the world browser (`worlds()` the public list, `world(id)`, `favourites()`, `setFavourite()` with PUT and DELETE; `cleanWorlds()` keeps only well-formed rows), connect tokens; `coreBase()` accepts https anywhere and http only on this machine |
| `src/main/loopback.ts` | The RFC 8252 loopback port: `listenForCallback(timeout, signal)` takes a port first, `expect(request)` afterwards; refuses any other request's callback (400); its page writes nothing from the request |
| `src/main/auth.ts` | `Auth`: the PKCE pair, the whole browser sign-in, the refresh token in a `TokenStore`, `access()` (one refresh at a time), `join()` |
| `src/main/settings-file.ts` | The settings file in the app's data folder, written to a temporary file then renamed |
| `src/main/core-url.ts` | `DEFAULT_CORE` (OQ-27); `--core=URL` and the settings' `core` field override it |
| `src/shared/settings.ts` | The settings shape and its cleaning, the actions and default keys, `bind`/`unbind`/`actionFor` (pure: main and page both import it) |
| `src/renderer/src/i18n/` | `en.ts` and `es.ts` (key for key), `makeI18n`, `pickLocale` |
| `src/renderer/src/ui/` | `ClientApp.vue` (the screens; join errors through `home.reasons`), `SignIn`, `HomeView` (the world browser, S2.09: join by world ID, favourites, the public list with players of capacity), `WorldRow` (a world, its star, its join button: disabled offline or full), `SettingsView` (rebinding by pressing a key; right-click clears), `WorldView`, `MicQuestion`, `keys.ts` (labels from the keyboard layout), `theme.css` |
| `src/renderer/src/world/` | `session.ts` (`WorldSession`), `controls.ts`, `remotes.ts`, `camera.ts`, `crowd-view.ts`, `plaza-scene.ts` |
| `tools/bots/src/e2e.ts` | The end-to-end test (below) |

## Signing In

| Rule | Why |
|---|---|
| Only the main process talks to the core. The page sees `{ status, account, remembered }` and gets connect tokens, never an access or refresh token | The page renders other people's content |
| `shell.openExternal` only ever gets the core's own `/signin` page: `CoreApi.loginRequest` checks the origin (the trap linter's T16 is allowed on that one line, with the reason) | A compromised answer cannot send the browser elsewhere |
| The refresh token is encrypted with `safeStorage`; on Linux with the `basic_text` backend (no secret service) it is kept in memory only, and the home screen says the player will sign in again | `basic_text` is a fixed key: not protection |
| `Auth.access()` shares one refresh between concurrent callers | A refresh token works once; two refreshes at once read as a stolen token and the core ends the session |
| An unreachable core at start keeps the stored token; any other refusal deletes it | A flaky network must not sign people out |
| Signalling may go to the private addresses of Stage 0, or to the exact address the core gave with the latest connect token (`signal(url, offer, joinedAddress)`). When that address is the core's own relay (`CoreApi.isRelay`), the main process posts the offer there with the account's token | The page cannot steer signalling to an arbitrary host, and never sees the token |
| The join ticket carries the core's `iceServers` (cleaned: `stun:`/`turn:` URLs only), passed to the page's `RTCPeerConnection` | TURN reaches worlds behind carrier-grade NAT |
| The page's permissions: the microphone (audio only) and pointer lock, in the app and the lounge; nothing else | Electron grants everything unless told |

## Settings, Keys and Languages

- Bindings store `KeyboardEvent.code` values (layout-free: `KeyW` is where W is on a US keyboard) and `Mouse0`–`Mouse4`; at most two per action; one code belongs to one action (`bind` moves it); `menu` (Escape) is fixed. Labels come from `navigator.keyboard.getLayoutMap()` when Chromium has it, so a French player sees Z for `KeyW`.
- Every word on the app's screens goes through vue-i18n (`t('…')`). ESLint's `vue/no-bare-strings-in-template` fails any bare text in `src/renderer/src/ui/**/*.vue`, and a test checks `es.ts` has exactly `en.ts`'s keys, none empty. A new word means both files.
- vue-i18n's flags are defined in `electron.vite.config.ts` (composition API only; JIT message compilation, which uses no `eval`, so the page's policy keeps no `unsafe-eval`).
- The spike screens (`App.vue`'s HUD, the lounge, the crowd bench) still use global classes such as `.hud`; the app's views use their own (`.whud`). A global spike class once stretched the world's voice indicator from top to bottom.

## The World View

| Part | Rule |
|---|---|
| `WorldSession` | Joins with `WorldConnection`, moves the player with `packages/sim` every frame, sends the pose 20 times a second, applies corrections, interpolates everyone else, runs the camera, chat and the voice chain. It records the player's entity from `welcome` (which comes before the join's first snapshot), or the player is drawn a second time as a stranger |
| `Remotes` | Each player drawn in the past by about one update interval of their own (100 ms near, up to 1.3 s for 1 Hz far players), turning the short way round |
| `CrowdView` | Bodies, visors and speaking rings are three instanced meshes; the colour buffer is created before the first draw (a shader built without it ignores colours); name tags are canvas sprites (text drawn as pixels, never markup) for the nearest 32 within 25 m |
| `cameraPose` | First person at the eyes; third person 3.6 m behind, pulled in before any solid |
| Input | Keys always (unless the chat box has focus: `session.typing`); mouse look only under pointer lock, which a click asks for; Escape releases the lock and the page opens the menu |
| Chat | World-wide; the client keeps the server's limits (a burst of 5, then one per 1.5 s; 280 characters) and says "slow down" instead of sending what the server would drop; joins and leaves become notices the page words in its language |
| Travel (S2.11) | The world's `portal` message calls `session.onTravel`; `WorldView` emits `travel`; `ClientApp.goThrough` asks the core for the world (`world(id)`: offline or missing keeps the player where they are, with a line saying why for 5 s), then a connect token, and replaces the world: `WorldView` is keyed by `visit`, so it remounts, the old session leaves with `travel` (`conn.close(detail, 'travel')`), and the new one joins with the portal's spawn group in `hello` |
| Voice | The first time in a world, `MicQuestion` asks: open microphone (highlighted) or push-to-talk. Hearing works without a microphone. Push-to-talk and self-mute set `chain.muted`; `chain.sending` drives the "Talking" indicator |

## Downloaded Worlds and Physics (S2.04, S2.06)

| Part | Rule |
|---|---|
| Downloading | A `content` message during the join names the built world; `Downloader` (`world/download.ts`) takes what the cache has, fetches the rest one file at a time, puts chunks together strictly in order, checks each file's SHA-256 (`crypto.subtle`), and reads world.json with `parseBuiltWorld`; a stall of 30 s, a hash mismatch or chunks out of order end it. The HUD shows the percentage |
| The cache | `src/main/content-cache.ts` in the app's data folder (`content/<sha256>`), filled through the bridge (`contentHas`, `contentGet`, `contentPut`); the main process keeps a file only if its bytes match its name; 2 GB, least recently used dropped first |
| Scenes | `world/scene-loader.ts`: `checkGlb` refuses a GLB that is not self-contained (any `uri`) or fails `inspectScene`; GLTFLoader with three's `MeshoptDecoder` and `KTX2Loader` (T11 allowed on those imports, with the reason); objects static (`matrixAutoUpdate` off) |
| Physics | `world/physics.ts`: Rapier's kinematic character controller (`@dimforge/rapier3d-compat`, whose WebAssembly is inside the bundle) over the world's colliders, with `packages/sim`'s speeds, jump and step; autostep 0.45 m, snap to ground 0.4 m, slopes to 45°. A world made in code (the plaza without content) gets its boxes as colliders (`mapColliders`) |

## The End-to-End Test

`node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--shots DIR] [--keep]` runs Stage 1's path with every real program: a private PostgreSQL (`apps/core/scripts/db.ts`), the core, an account from an invitation, two worlds registered and approved through the admin command line, two world servers on plazas whose portals lead to each other (`tools/converter/scripts/make-travel.ts`; relayed through the core, downloaded by the client), and the packaged client under Playwright (`playwright-core`'s `_electron`). It replaces `shell.openExternal` in the main process, plays the browser over HTTP (the sign-in page, the form, the redirect to the loopback port), then clicks through the app: the plaza's row in the world browser, the microphone question, walking, a jump, a chat line, then walking backwards through the portal into the garden. It passes when the first world's summary shows 1 join, more than 10 applied poses, 1 chat line, at least 3 fetches, a `portal` and one `leave:travel`, and the second world 1 join. It needs a display (`xvfb-run -a` in CI's Linux job) and PostgreSQL's programs. Give the client a fresh profile (`XDG_CONFIG_HOME`), or a remembered session skips the sign-in screen.

## Correct vs. Incorrect

**Incorrect:** handing the page a token to call the core itself.
```ts
contextBridge.exposeInMainWorld('flatchat', { accessToken: () => ipcRenderer.invoke('flatchat:token') });
```
**Correct:** the page asks for what it needs; the main process holds the session.
```ts
contextBridge.exposeInMainWorld('flatchat', { joinWorld: (id: string) => ipcRenderer.invoke('flatchat:join', id) });
```
**Why:** anything the page holds, a hostile world's content could read; a connect token is good for one world for 60 seconds, an account token for everything.

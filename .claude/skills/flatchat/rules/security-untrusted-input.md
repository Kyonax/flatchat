---
title: Untrusted Input — Never Run, Render as HTML or Load Raw What Other People Made
impact: CRITICAL
impactDescription: On a social platform every name, chat line, world file, avatar, plugin and network message comes from strangers; running it as code, injecting it as HTML, parsing raw asset files in the client, sandboxing with node:vm or building shell commands from it hands those strangers the player's or the host's machine (traps T05, T06, T11, T12, T13).
tags: security, untrusted input, user content, strangers, chat, display name, world files, avatars, assets, uploads, plugins, network messages, eval, new Function, string timers, innerHTML, outerHTML, insertAdjacentHTML, document.write, v-html, xss, html injection, gltf, glb, vrm, fbx, obj, ktx2, three loaders, GLTFLoader, converter, content package, node:vm, vm, sandbox, child_process, exec, execSync, execFile, spawn, shell injection, validation, T05, T06, T11, T12, T13
---

This rule governs what the code may do with anything that did not come from this repository: display names, chat text, world and avatar files, uploaded models, plugin code and every network message. FlatChat exists so strangers can share worlds, avatars and voice, which makes their input the platform's main attack surface. The trap linter (`npm run lint:traps`) checks the patterns marked with a trap id; the rest is review discipline.

## The Five Traps

| Trap | Pattern found | Severity | Do this instead |
|---|---|---|---|
| T05 | `eval(…)`, `new Function(…)`, `Function(…)`, `setTimeout` or `setInterval` given a string | error | Parse data (JSON, the protocol's codecs); never execute it |
| T06 | Assigning `innerHTML` or `outerHTML`, `insertAdjacentHTML(…)`, `document.write(…)`, Vue's `v-html` | error | Vue's `{{ }}` interpolation, or `textContent`; formatting by building elements, never by parsing markup |
| T11 | Importing three's file loaders (`three/addons/loaders/…`, `three/examples/jsm/loaders/…`) anywhere in `apps/client` | warning | The client loads only the platform's own validated format through the content package; raw loaders belong to `tools/converter` |
| T12 | Importing `vm` or `node:vm` | error | `node:vm` is not a sandbox. Code from strangers (object scripts, after the MVP) runs only in its own process with no ambient authority; host-installed plugins go through the host interface (rule `plugins`) |
| T13 | `exec` or `execSync` from `child_process` | warning | `execFile` or `spawn` with an argument array: no shell, so no shell injection |

Strings and comments that mention these names never trigger the linter: it parses the code. One line can opt out, with a reason, through a comment on it or on the line above: `// trap-lint: allow T11 because <reason>`. Use that only for a reviewed exception, never to silence a finding.

## Where Untrusted Input Enters, and the Rule for Each

| Source | Arrives in | Rule |
|---|---|---|
| Display names, chat text, world names and descriptions | Client UI (Vue), world server, core | Text only, rendered with `{{ }}`; length-limited and validated where it enters |
| Network messages | World server, client, core | `decodeMessage(bytes, sender)` only: it refuses unknown, malformed, oversized and wrong-direction messages with a `ProtocolError` (rule `protocol-and-codecs`); drop the packet and count the code, never let it stop a tick, never `JSON.parse` a raw packet into trusted state. The world server also refuses a message on the wrong channel, closes a link after 50 malformed messages, and rate-limits voice (60 frames a second) and chat (one line a second) per player (`world-networking`) |
| Uploaded models, textures, animations, effects | The core's upload path, then `tools/converter` | Converted to the platform's own format, validated and ranked before anyone downloads them; each converter (an avatar's, an item's) runs in its own process under Node.js's permission model (reads of its code and the upload, and for an item the standard bodies, writes of its folder, no addons, workers or child processes, a network namespace where `unshare` works, ten minutes, 3 GB): `converterArgs` and `runConverter` in `apps/core/src/sandbox.ts`, rules `avatar-converter` and `items` |
| World and avatar files downloaded by a client | Client | Only the platform's format, from the core's asset store, checked against its manifest |
| A world's effects (S6.01) | Client, from the world's host | The host can skip the converter, so the client takes nothing it says: each effect is read and checked by the upload rules (`checkEffectBundle`) and measured again in a worker ended past the deadline before it plays; only the client's own numbers decide (rule `effects`); `tools/converter/scripts/hostile-effects.ts` is the hostile host the end-to-end test uses |
| A world's screen overlays (S6.02) | Client, from the world's host | Each PNG's header is checked against the world overlay's size limit before a blob URL is made (`overlayImageProblems`); shown only as an image, never parsed as anything else (rule `overlays`) |
| World plugins | World server | Code the host chose to install, imported by the world server (T-04): they reach the world only through the host interface, whose calls check the permissions declared in `plugin.toml` and shown at install (rule `plugins`); never `node:vm`, never `eval`. Code from strangers waits for a sandboxed process offering the same interface |
| Links in chat or worlds | Client | Never opened without a check; see the client rule's `shell.openExternal` allow-list |

"Never load engine-native resource files from strangers" is the general form of T11: a raw loader parses whatever bytes it is given, so a crafted file reaches the parser, the GPU driver and the memory budget unchecked. Only the converter, which runs where a crash costs nothing and its output is validated, reads raw formats. Until the content package's loader exists, the client loads no outside assets at all.

## Correct vs. Incorrect

**Incorrect:** formatting a chat line as HTML.
```vue
<p v-html="`<b>${msg.author}</b>: ${msg.text}`" />
```
**Correct:**
```vue
<p><b>{{ msg.author }}</b>: {{ msg.text }}</p>
```
**Why:** a display name such as `<img src=x onerror=…>` would run in every viewer's client (T06).

**Incorrect:** loading a stranger's avatar straight into the scene.
```ts
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
new GLTFLoader().load(avatar.url, (gltf) => scene.add(gltf.scene));
```
**Correct:** the client asks the content package for an asset that the converter produced and the manifest lists, with its rank and size checked.
**Why:** a crafted file reaches the parser and the GPU unvalidated, and an unranked avatar can stall every viewer (T11).

**Incorrect:** running a world plugin in a `vm` context.
```ts
import vm from 'node:vm';
vm.runInNewContext(pluginSource, { world });
```
**Correct:** a host-installed plugin (S3.01) is imported as a module and handed only the host interface (`HostApi`), whose calls check the permissions in its `plugin.toml`; code from strangers (object scripts, after the MVP) runs in a separate sandboxed process that offers the same interface.
**Why:** `node:vm` shares the process; its own documentation says it is not a security mechanism (T12).

**Incorrect:** building a shell command from a file name.
```ts
import { execSync } from 'node:child_process';
execSync(`blender --background --python bridge.py -- ${file}`);
```
**Correct:**
```ts
import { execFileSync } from 'node:child_process';
execFileSync('blender', ['--background', '--python', 'bridge.py', '--', file]);
```
**Why:** a file name containing `; rm -rf ~` runs as a command with `exec` (T13).

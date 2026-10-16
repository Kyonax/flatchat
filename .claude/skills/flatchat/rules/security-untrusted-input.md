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
| T12 | Importing `vm` or `node:vm` | error | Run untrusted code (world plugins) in its own process with no ambient authority |
| T13 | `exec` or `execSync` from `child_process` | warning | `execFile` or `spawn` with an argument array: no shell, so no shell injection |

Strings and comments that mention these names never trigger the linter: it parses the code. One line can opt out, with a reason, through a comment on it or on the line above: `// trap-lint: allow T11 because <reason>`. Use that only for a reviewed exception, never to silence a finding.

## Where Untrusted Input Enters, and the Rule for Each

| Source | Arrives in | Rule |
|---|---|---|
| Display names, chat text, world names and descriptions | Client UI (Vue), world server, core | Text only, rendered with `{{ }}`; length-limited and validated where it enters |
| Network messages | World server, client, core | Decoded by the protocol's codecs with size limits; reject unknown or oversized messages, never `JSON.parse` a raw packet into trusted state |
| Uploaded models, textures, animations, effects | The core's upload path, then `tools/converter` | Converted to the platform's own format, validated and ranked before anyone downloads them |
| World and avatar files downloaded by a client | Client | Only the platform's format, from the core's asset store, checked against its manifest |
| World plugins | World server | Their own process and permissions, declared in `plugin.toml`; never `node:vm`, never `eval` |
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
**Correct:** start the plugin as a separate process with only the permissions its manifest declares, talking to the server over a message channel.
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

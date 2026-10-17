---
title: The Harness and the Trap Linter — One Command for Every Headless Check, and How to Add a Check or a Trap
impact: HIGH
impactDescription: Work declared done without the harness's full pass misses whichever check was skipped, a trap added without its rule text or test fails the skill check or catches nothing, and a suppression without a reason hides a real security finding.
tags: harness, npm run harness, check.ts, checks, lock-check, package-lock, npm ci, verify, verification, done, layout, skill, skill-check, traps, trap linter, trap-lint, lint:traps, lint, eslint, types, typecheck, tests, server, bots, client, --with-client, --only, --skip, --list, --verbose, github actions groups, adding a trap, adding a check, TRAPS table, suppress, allow comment, exit codes, json output, --strict
---

This rule governs `tools/harness`: the single command that tells whether the repository is healthy, the trap linter inside it, and how either grows. Agents finish every change by running `npm run harness`; CI runs the same command, so a green harness locally predicts a green checks job.

## The Harness (`npm run harness`)

| Check | What runs | Passes when |
|---|---|---|
| `lock` | `node tools/harness/src/lock-check.ts` | `package-lock.json` lists every workspace (with its `node_modules` link) and the same dependency lists as every `package.json`, as CI's `npm ci` requires |
| `layout` | `node tools/repo/check-layout.mjs` | Folders, licence files, LICENSING rows and SPDX headers are right |
| `skill` | `node tools/harness/src/skill-check.ts` | The agent skill has the shape agents rely on (see below) |
| `traps` | `node tools/harness/src/trap-lint.ts` | No trap at error level |
| `lint` | `npm run lint` (ESLint 10 over the whole repository) | No ESLint error |
| `types` | `npm run typecheck` (every workspace's `tsc` or `vue-tsc`) | No type error |
| `tests` | `npm test` (every workspace's `vitest run`) | Every test passes |
| `server` | `node apps/world-server/src/main.ts --port 0 --tick-hz 50 --ticks 50` | A `ready` line with a port, the protocol version and the schema fingerprint; a `stopped` line with `tick-limit` and 50 ticks; exit 0 |
| `bots` | `node tools/bots/src/run.ts smoke` | A world server and 12 bots on each transport (raw UDP and WebRTC, at once) for 4 s on loopback: every bot joins, none is lost, each gets snapshots and pongs, voice is forwarded, no correction or malformed message (`bots-and-load-tests`) |
| `client` (only with `--with-client`) | `npm run client:smoke` | The built client draws on a backend (needs a display) |

| Option | Effect |
|---|---|
| `-- --list` | Print the checks |
| `-- --only traps,tests` | Run only these |
| `-- --skip server` | Run all but these |
| `-- --with-client` | Add the client smoke test |
| `-- --verbose` | Stream each check's output |

Each check prints `PASS` or `FAIL`, its name, title and duration; a failure prints the last 80 lines of its output. The last line reads `harness: N of M passed in S s`, plus the failed names. Exit 0 when all pass, 1 when any fails, 2 for an unknown option or check name. Under GitHub Actions (`GITHUB_ACTIONS=true`) each check's output streams inside a collapsible `::group::`, and a failure adds an `::error::` annotation.

## The Skill Check (`skill`)

It fails when: `SKILL.md` lacks frontmatter, its `name` is not `flatchat`, its description is missing, multi-line or over 1024 characters, or the file reaches 500 lines; a file in `rules/` has no routing row (in "When to Read Which Rules") or no Quick Reference row; a row names a rule file that does not exist; a rule lacks `title`, `impact` (CRITICAL, HIGH, MEDIUM or LOW), `impactDescription` or `tags`; a trap names a rule file that is missing or never mentions the trap's id; `AGENTS.md` is missing or does not point to `.claude/skills/flatchat/SKILL.md`.

## The Trap Linter (`npm run lint:traps`)

| Reads | How |
|---|---|
| `.ts .mts .cts .tsx .js .mjs .cjs .jsx` under `apps`, `packages`, `tools` | TypeScript's own parser: only code matches, never strings or comments |
| `.vue` | Each `<script>` block parsed the same way; the `<template>` read for `v-html` |
| `.html` under `apps/client/src/renderer` | The `Content-Security-Policy` meta tag |
| `.github/workflows/*.yml` | Parsed as YAML: every job's `timeout-minutes`, and the Linux smoke steps |

Skipped folders: `node_modules out dist build release coverage .cache third_party .git`. Options: `--root DIR`, `--strict` (warnings fail too), `--json` (machine output). Exit 0 clean, 1 on errors (or warnings with `--strict`), 2 on bad options. Each finding prints the severity, the trap id, `file:line`, the trap's title, what was found, the fix, and the rule that explains it.

| Trap | Severity | Rule file that explains it |
|---|---|---|
| T01 Node.js reachable from web content | error | `client-electron` |
| T02 context isolation turned off | error | `client-electron` |
| T03 renderer sandbox turned off | error | `client-electron` |
| T04 web security weakened | error | `client-electron` |
| T05 code built from strings | error | `security-untrusted-input` |
| T06 HTML built from data | error | `security-untrusted-input` |
| T07 renderer page without a strict CSP | error | `client-electron` |
| T08 Electron or Node.js imported in the renderer | error | `client-electron` |
| T09 raw IPC handed to the page | error | `client-electron` |
| T10 default application menu left in place | error | `client-electron` |
| T11 raw asset loader in the client | warning | `security-untrusted-input` |
| T12 node:vm used | error | `security-untrusted-input` |
| T13 shell command run through exec | warning | `security-untrusted-input` |
| T14 CI job without a time limit | error | `ci-github-actions` |
| T15 Linux client smoke test that cannot draw | error | `ci-github-actions` |
| T16 external link opened unchecked | warning | `client-electron` |
| T17 Node.js API in a shared package (`packages/*/src/`) | error | `protocol-and-codecs` |

A reviewed exception is marked on the line or the line above: `// trap-lint: allow T13 because the command is a fixed literal`. Several ids may follow `allow`. Never add an allow comment to make a run pass; fix the code.

## Adding a Trap

1. A trap comes from a real failure or a documented hazard, never a style preference.
2. Add it to `TRAPS` in `tools/harness/src/trap-lint.ts`: the next free id, `severity`, `rule` (an existing rule file's name), `title`, `fix`.
3. Detect it in the matching scanner (`scanCode`, `scanVue`, `scanHtml`, `scanWorkflow`), on parsed code where possible.
4. Add a test in `tools/harness/test/trap-lint.test.ts` that plants it in an inline source, and a clean case that must pass.
5. Explain it, by id, in the named rule file, and add it to the table above; the skill check fails until the rule mentions the id.
6. Run `npm run harness`; the repository itself must lint clean.

## Adding a Harness Check

Add an entry to `CHECKS` in `tools/harness/src/check.ts` (`name`, `title`, `run`, and `optional: true` when it needs a display or hardware), keep it deterministic and headless, and document it in the table above and in `tools/harness/README.md`.

## Correct vs. Incorrect

**Incorrect:** "done" after running only the tests of the changed workspace.
**Correct:** `npm run harness`, and the client's `--with-client` or a smoke run when the client's rendering or window changed.
**Why:** the layout, skill, trap and type checks catch what a workspace's tests cannot, and CI runs all of them.

**Incorrect:** silencing a finding.
```ts
// trap-lint: allow T06
el.innerHTML = message;
```
**Correct:**
```ts
el.textContent = message;
```
**Why:** T06 exists because chat text comes from strangers; an allow comment without a reviewed reason hides an attack path.

---
title: Packaging the Client for Linux and Windows — electron-builder Targets, a Windows Zip Built on Linux, and Checking It on a Windows Machine Without a GPU
impact: MEDIUM
impactDescription: Turning on executable signing or a Windows installer target makes Linux builds need Wine or Docker, changing Electron in one place but not the other ships a mismatched runtime, and checking a Windows build from a remote shell starts a program that never gets a desktop, so it seems to run while drawing nothing.
tags: packaging, electron-builder, electron-builder.yml, dist, dist:linux, dist:win, release, linux-unpacked, win-unpacked, zip, dir target, asar, appId, productName, executableName, electronVersion, signAndEditExecutable, wine, docker, windows build, windows vm, windows runner, scheduled task, interactive session, ssh, gui program, smoke-out, warp, Microsoft Basic Render Driver, proton
---

This rule governs turning the built client into something a person can run, on Linux and on Windows, and checking the Windows build without a Windows desktop at hand. Packaging uses electron-builder with `apps/client/electron-builder.yml`; electron-vite first builds `apps/client/out/`.

## The Configuration

| Key | Value | Why |
|---|---|---|
| `appId` | `com.kyonax.flatchat` | Stable identity for later installers and updates |
| `productName` | `FlatChat` | The Windows executable becomes `FlatChat.exe` |
| `electronVersion` | `44.8.0` | Must equal `electron` in `apps/client/package.json`; change both together |
| `directories.output` | `release` | Builds land in `apps/client/release/` (git-ignored) |
| `files` | `out/**`, `package.json` | Only the built app ships |
| `asar` | `true` | The app's files packed in one archive |
| `linux.target` | `dir` | An unpacked folder: `release/linux-unpacked/flatchat` |
| `linux.executableName` | `flatchat` | Lowercase executable on Linux |
| `linux.category` | `Game` | Desktop-entry category for later packages |
| `win.target` | `zip`, `nsis` | The portable zip and `release/win-unpacked/FlatChat.exe`; the per-user installer (S7.01, `nsis.oneClick`, `perMachine: false`, `FlatChat-<version>-windows-x64-setup.exe`), built on CI's Windows runner, which the self-update runs silently (`/S --force-run`) |
| `win.signAndEditExecutable` | `false` | Editing the executable's resources (icon, version info) and signing need Wine on Linux; this stays off until release builds |

| Command | Result |
|---|---|
| `npm run dist:linux -w @flatchat/client` | `electron-vite build`, then `release/linux-unpacked/` |
| `npm run dist:win -w @flatchat/client` | `electron-vite build`, then the Windows zip, built on Linux without Wine |

The first build per platform downloads that platform's Electron zip. Building a Windows installer (NSIS, MSI) or signing needs Wine or Docker on Linux; until release builds exist, Windows artefacts come from the zip target here or from CI's `windows-2025` job.

## The Self-Update (S7.01)

| Part | Where |
|---|---|
| The feed | `apps/client/src/shared/update.ts`: `flatchat-update.json` (format 1, version, released, `packages` per `linux-x64`/`win32-x64`: https url, sha256, bytes) and `flatchat-update.json.sig` (Ed25519, base64); `readUpdateManifest`, `isNewer` (three numbers only) |
| The check | `apps/client/src/main/update.ts`: `verifyFeed` (the raw 32-byte key in an SPKI prefix), `checkForUpdate` (size-limited reads, signature before parsing, download with size and SHA-256, a wrong package deleted), `applyPlan` (AppImage in place, the installer under `%LOCALAPPDATA%\Programs`, else manual) |
| The key and address | `apps/client/src/main/update-key.ts`: `UPDATE_FEED` (kyonax.com/flatchat/updates/), `UPDATE_PUBLIC_KEY` (the owner's; empty = no updates, OQ-34) |
| In the app | `main/index.ts`: `startUpdates` (packaged, key, `settings.updates`; 20 s after start), `flatchat:update` / `update-state` / `update-apply`; the home screen's banner (`data-test=update-ready`) |
| Release scripts | `apps/client/scripts/update-keygen.ts` (the owner, once), `update-feed.ts` (writes and signs the feed) |
| Tests | `test/update.test.ts`; CI Linux: `tools/bots/src/update-check.ts` with `--update-check --update-feed --update-key` (a loopback feed only); CI Windows: the installer in and out silently |

Never accept `--update-key` with a feed that is not on this machine: a key on the command line is for tests. Read the signature before parsing the feed; never keep a package whose hash or size differs from the signed feed's.

## Checking a Windows Build

| Where | What it shows |
|---|---|
| CI's `client-windows` job | The real build on Windows Server 2025 drawing WebGL2 on WARP; the zip is kept 7 days |
| A Windows VM without a GPU | The same software path (WebGL2 on Microsoft Basic Render Driver, about 33 fps for the blank scene): a fallback check, not performance |
| A Windows PC or laptop with a GPU | The only place for Windows performance numbers |
| Proton or Wine on Linux | Possible, but not a check of the Windows build's behaviour |

On a remote Windows machine, a GUI program started from an SSH or service session runs without a visible desktop. Start it inside the logged-in user's session: register a scheduled task with an interactive logon for that user and start the task, or use the session's own terminal. When a task has no arguments, leave its argument field out entirely: PowerShell's `New-ScheduledTaskAction` rejects an empty `-Argument`, and a launcher that ignores the error reports success while starting nothing. Make every launcher stop on errors and check that the program exists first. A GUI program's stdout is not captured in that path either, so pass `--smoke-out=FILE` (or `--bench-out=FILE`) and read the file afterwards.

## Correct vs. Incorrect

**Incorrect:** asking for an installer on Linux.
```yaml
win:
  target: nsis
```
**Correct:** keep `target: zip` and `signAndEditExecutable: false` until release builds have a Windows signing machine.
**Why:** NSIS and resource editing need Wine on Linux; the build fails on machines and runners that do not have it.

**Incorrect:** upgrading Electron in `package.json` only.
**Correct:** change `electron` in `apps/client/package.json` and `electronVersion` in `electron-builder.yml` in the same change, then run the smoke test on both platforms.
**Why:** the development runtime and the packaged runtime would differ, so local checks would no longer predict the shipped build.

**Incorrect:** judging a remote Windows run from the launcher's "started" message.
**Correct:** read the smoke file it wrote, or take a screenshot of the session.
**Why:** a launcher that hides an error prints "started" for a program that never ran.

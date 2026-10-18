# Downloads and updates

FlatChat is downloaded from kyonax.com and keeps itself up to date (Stage 7's S7.01): an AppImage or a .tar.gz on Linux, an installer or a portable zip on Windows. A packaged FlatChat looks for a later version a while after it starts; when it finds one, it downloads it, checks it, and asks the player to restart. Nothing is trusted unless it is signed with the owner's key.

## How a client updates

1. Twenty seconds after a packaged FlatChat starts (when the owner's key is built in and the player has not switched updates off in Settings), it fetches `flatchat-update.json` and its signature `flatchat-update.json.sig` from `https://kyonax.com/flatchat/updates/` (`apps/client/src/main/update-key.ts`). Each is read up to a size limit.
2. The signature must check against the owner's Ed25519 public key built into the client. A feed signed with another key, or changed after it was signed, is refused and nothing is downloaded.
3. The feed names the newest version and, for each platform, its package's address, SHA-256 and size (`apps/client/src/shared/update.ts`). A version that is not later than the running one, or no package for this computer, is the end of it.
4. The package is downloaded into the player's data folder, its size checked as it comes and its SHA-256 at the end; a package that is not the one the feed names is deleted and refused.
5. The home screen says the new version is ready. On "Restart to update":
   - an **AppImage** replaces itself (the new file beside it, then renamed over it) and starts again;
   - the **Windows installer** runs silently (`/S --force-run`) and starts FlatChat again;
   - a **.tar.gz**, the **portable zip** or a folder cannot replace itself: the home screen says the new version is on kyonax.com.

With no key built in (`UPDATE_PUBLIC_KEY` empty), a client never looks for updates.

## The owner's steps

Once, on his own machine:

```sh
node apps/client/scripts/update-keygen.ts            # writes ~/.flatchat-release/update-key.pem (only he can read it)
```

It prints the public key: it goes into `apps/client/src/main/update-key.ts` as `UPDATE_PUBLIC_KEY`. The private key never leaves his machine; a copy is kept somewhere safe, since every future release is signed with it.

For each release:

1. Set the version in `apps/client/package.json` (three numbers; a release's version is always later than the last).
2. Build the packages: CI's artifacts (`flatchat-linux`: the AppImage and the .tar.gz; `client-windows`: the zip and `FlatChat-<version>-windows-x64-setup.exe`), or `npm run dist:testers -w @flatchat/client` and `npm run dist:win -w @flatchat/client`.
3. Write and sign the feed:

   ```sh
   node apps/client/scripts/update-feed.ts --version 1.2.3 --key ~/.flatchat-release/update-key.pem \
     --linux FlatChat-1.2.3-linux-x86_64.AppImage --windows FlatChat-1.2.3-windows-x64-setup.exe
   ```

4. Upload the packages, `flatchat-update.json` and `flatchat-update.json.sig` to `kyonax.com/flatchat/updates/`, packages first, the feed last.

## Install and uninstall

The Windows installer installs for the current user only (no administrator), under `%LOCALAPPDATA%\Programs`, with a Start menu entry and an uninstaller (Settings, Apps). The player's data (settings, sign-in, downloaded worlds) stays on uninstall. On Linux the AppImage needs no install; delete the file to remove it.

## Tests

- `apps/client/test/update.test.ts`: the feed's format and version order, the signature (as signed, changed, another key, garbage), a later version downloaded and checked, the same version left alone, a wrong package refused and deleted, a longer one cut off, the plan for each kind of install.
- CI's Linux job: `tools/bots/src/update-check.ts` runs the packaged client with `--update-check` against a feed on the runner signed with a throwaway key (`--update-feed` and `--update-key` are accepted only for a feed on this machine): the good feed downloads, a changed feed, a swapped package and another key are each refused.
- CI's Windows job: the installer goes in silently, the installed FlatChat draws (its smoke test), and the uninstaller takes it out.
- The owner's check (the plan's Verify): install, update and uninstall on clean machines.

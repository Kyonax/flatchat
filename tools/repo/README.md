# Repository checks

`check-layout.mjs` checks the repository against [layout.json](layout.json): the required files and folders, each folder's `LICENSE` text, the table in `LICENSING.md`, and an SPDX header in every source file that matches its folder's licence.

```sh
npm run check:layout                                # from the repository root
node tools/repo/check-layout.mjs --root path/to/copy
```

It needs only Node.js 20 or later, prints every problem it finds and exits 1 if there is one.

- Licence: MPL-2.0 (the root [LICENSE](../../LICENSE))

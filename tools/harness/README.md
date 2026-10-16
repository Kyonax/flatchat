# Harness

The repository's own checking and measuring tools.

- Licence: MPL-2.0 ([LICENSE](LICENSE))

| Command | File | What it does |
|---|---|---|
| `npm run harness` | `src/check.ts` | Every headless check in one command: the layout check, the agent-skill check, the trap linter, ESLint, TypeScript, the unit and process tests, and a headless world server run. `-- --list` shows them, `-- --only a,b` and `-- --skip a,b` pick, `-- --with-client` adds the client's smoke test (needs a display). CI runs it on every push. |
| `npm run lint:traps` | `src/trap-lint.ts` | The trap linter: the security and setup mistakes this project has met (T01–T16), found in parsed code, Vue templates, the renderer's HTML and the CI workflows. `--strict` fails on warnings, `--json` prints machine output. |
| (part of the harness) | `src/skill-check.ts` | Checks that the agent skill in `.claude/skills/flatchat` has the shape agents rely on, and that every trap is explained in its rule. |
| `npm run standin -- plan --target NAME` | `src/standin.ts` | The weak-laptop stand-in: prints every command of a run and changes nothing. |
| `npm run standin -- run --target NAME` | `src/standin.ts`, `src/standin-plan.ts` | Locks an NVIDIA card's clocks to a laptop class (sudo asks for the password), runs the client's bench on four CPUs with CPU and memory caps, logs every frame time, then always resets the clocks and checks that they are free again. |
| `npm run standin -- status` / `reset` | `src/standin.ts` | The card's clocks now; the two reset lines alone. |

## The stand-in's profile

The clocks and limits for each target belong to the machine, so the profile lives outside the repository: `--profile FILE`, else `$FLATCHAT_STANDIN_PROFILE`, else `~/.config/flatchat/standin.json`. Its format and the method for deriving one from a card's specifications are in the agent skill's rule [weak-laptop-stand-in](../../.claude/skills/flatchat/rules/weak-laptop-stand-in.md). The run needs a built client (`npm run dist:linux -w @flatchat/client`) and a systemd user manager that delegates the cpu and memory controllers.

## Tests

`npm test -w @flatchat/harness`: the trap linter against planted traps, the skill check on throwaway folders, and the stand-in's whole sequence against a recording runner, so no GPU, sudo or client is needed.

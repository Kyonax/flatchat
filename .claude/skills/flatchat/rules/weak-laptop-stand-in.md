---
title: The Weak-Laptop Stand-In — Imitating an Iris Xe or Radeon 680M Laptop on a Desktop NVIDIA Card, Safely
impact: HIGH
impactDescription: Performance targets are set for integrated-graphics laptops; measuring on a full-speed desktop flatters every number, a stand-in run whose clock lock did not hold measures nothing, and a locked card that is never reset stays slow for every other program until a reboot.
tags: stand-in, standin, weak laptop, floor, iris xe, intel iris xe, radeon 680m, 680m, integrated graphics, igpu, nvidia-smi, lock-gpu-clocks, lock-memory-clocks, reset-gpu-clocks, reset-memory-clocks, lgc, lmc, rgc, rmc, sudo, clocks, supported clocks, tflops, fp32, memory bandwidth, gddr6, cpu quota, CPUQuota, MemoryMax, systemd-run, scope, taskset, cgroup, delegation, bench, frame times, 1280x720, profile, standin.json, FLATCHAT_STANDIN_PROFILE, plan, run, status, reset, verdict, lock held, reset verified, tuning, real laptop
---

This rule governs `npm run standin`: making a desktop with an NVIDIA card behave like an integrated-graphics laptop (the platform's performance floor: an Intel Iris Xe or AMD Radeon 680M class machine at 30 fps and 720p), running the client's bench on it, and putting the card back. The clock lines need root, so they run through `sudo` in the terminal of the person who owns the machine; an agent prepares the profile and the plan, reads the results, and never changes the system's sudo configuration.

## What It Imitates, and How

| Part of a laptop | How the stand-in imitates it |
|---|---|
| GPU compute | `nvidia-smi --lock-gpu-clocks=X,X`: the graphics clock fixed so the card's FP32 rate matches the target's |
| GPU memory bandwidth | `nvidia-smi --lock-memory-clocks=Y,Y`: the supported memory clock nearest the target's bandwidth, usually below it |
| CPU cores | `taskset --cpu-list 0-3`: the client on four CPUs |
| CPU throughput | `systemd-run --user --scope -p CPUQuota=…`: a cap on the client's total CPU time |
| RAM | `systemd-run … -p MemoryMax=…`: a cap on the client's processes' memory |
| Screen | The client's bench mode draws a fixed 1280×720 buffer |

The user scope needs the systemd user manager to delegate the `cpu` and `memory` controllers (check `/sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`). `CPUQuota` caps total CPU time, not single-thread speed: a busy main thread still runs at the desktop's clock, so results bound by one thread stay optimistic. The desktop card's own video memory is not capped; an integrated GPU shares system RAM with the CPU, which the stand-in does not reproduce.

## Deriving a Profile for a Card

| Quantity | Formula |
|---|---|
| FP32 rate (TFLOPS) | shader cores × 2 × graphics clock (GHz) ÷ 1000 |
| Graphics clock for a target | target TFLOPS × 1000 ÷ (2 × shader cores), then the nearest clock the card offers |
| Memory bandwidth (GB/s), GDDR6 | memory clock as `nvidia-smi` reports it (MHz) × 2 × bus width (bits) ÷ 8 ÷ 1000 |

| Target class | FP32 | Memory bandwidth (shared) | Typical CPU |
|---|---|---|---|
| Intel Iris Xe, 80–96 EU at about 1.3 GHz | about 1.7–2.0 TFLOPS | 51–68 GB/s (dual-channel DDR4-3200 to LPDDR4X-4266) | 4 cores, 8 threads, 15–28 W |
| AMD Radeon 680M, 12 CU at 2.2–2.4 GHz | about 3.4–3.7 TFLOPS | 77–102 GB/s (DDR5-4800 to LPDDR5-6400) | 8 cores at 15–45 W |

Worked example for an illustrative card with 2048 shader cores and a 256-bit GDDR6 bus: for the Iris Xe class, 1.9 TFLOPS × 1000 ÷ 4096 ≈ 464 MHz, so the nearest offered graphics clock, for example 465 MHz; its bandwidth at a reported 7001 MHz is 7001 × 2 × 256 ÷ 8 ÷ 1000 ≈ 448 GB/s, so the target's 51–68 GB/s needs a memory clock near 800–1060 MHz, and the nearest offered one (for example 810 MHz, about 52 GB/s) is used. Only a clock the card offers *for that memory clock* can be locked; list them with `nvidia-smi -q -d SUPPORTED_CLOCKS` (read-only). Cards often offer just a few memory clocks (for example 405, 810, 5001, 6801 and 7001 MHz), so the bandwidth match is coarse; prefer the lower one, since the target is a floor.

These spec-derived numbers are a starting point. Architectures differ in caches and compression, so a profile is **tuned** against a real laptop: run the same bench (`--bench=60` on the laptop's client build) on both, and adjust `graphicsClockMHz` until the stand-in's average and 1% low match the laptop's within about 10%. Record what it was tuned against in the profile's `source` and `note`.

## The Profile File

The profile belongs to the machine, not the repository. The script reads `--profile FILE`, else `$FLATCHAT_STANDIN_PROFILE`, else `~/.config/flatchat/standin.json`:

```json
{
  "gpu": "<the exact output of: nvidia-smi --query-gpu=name --format=csv,noheader>",
  "source": "how the numbers were derived, and what they were tuned against",
  "targets": {
    "iris-xe": {
      "label": "Intel Iris Xe class (96 EU), 8 GB laptop",
      "graphicsClockMHz": 465,
      "memoryClockMHz": 810,
      "cpus": "0-3",
      "cpuQuota": "300%",
      "memoryMax": "4G",
      "size": "1280x720",
      "note": "provisional until tuned against a real laptop"
    }
  }
}
```

| Field | Rule |
|---|---|
| `gpu` | Must equal the card's name, or the run refuses to start |
| target name | Lowercase letters, digits and dashes (`iris-xe`, `680m`) |
| `graphicsClockMHz`, `memoryClockMHz` | Whole MHz; the pair must be in the card's supported list |
| `cpus` | A CPU list such as `0-3` or `0,2,4,6` |
| `cpuQuota` | A percentage of one CPU, such as `300%` |
| `memoryMax` | systemd's size syntax, such as `4G` |
| `size` | The bench's drawing buffer, such as `1280x720` |

## The Commands

| Command | What it does | Root? |
|---|---|---|
| `npm run standin -- plan --target iris-xe` | Read-only preflight, then every command of a run, numbered; changes nothing | No |
| `npm run standin -- run --target iris-xe [--seconds 60]` | The run below | sudo for the four clock lines |
| `npm run standin -- status` | The card's current clocks, maximums and the applications-clocks reason (read-only) | No |
| `npm run standin -- reset` | The two reset lines alone | sudo |

Options: `--profile FILE`, `--seconds N` (5–3600, default 60), `--client PATH` (default `apps/client/release/linux-unpacked/flatchat`, built by `npm run dist:linux -w @flatchat/client`), `--out DIR` (default `out/standin`), `--gpu-index N` (default 0), `--no-query` (skip `nvidia-smi` in a plan, for machines without the card).

Preflight (refuses to run on any failure, with the card untouched): not root; Linux; `nvidia-smi`, `sudo`, `systemd-run` and `taskset` present; the card's name matches the profile; the clock pair is supported; the user manager delegates `cpu` and `memory`; the client build exists and is executable.

A run, in order: `sudo nvidia-smi --lock-gpu-clocks`, `sudo nvidia-smi --lock-memory-clocks`, a background `nvidia-smi --loop-ms=500` sampler into `clocks.csv`, the client's bench in the capped scope, then **always** `sudo nvidia-smi --reset-gpu-clocks` and `--reset-memory-clocks` (after a failed lock, a failed client and Ctrl+C alike), then a 4-second uncapped bench with the sampler again, to see the clocks rise. Sudo asks for the password in the person's terminal; run it in a real terminal, since a shell without a terminal cannot prompt.

## Reading the Results

Files in `out/standin/<time>-<target>/`: `frames.json` (the bench report with every frame time), `clocks.csv`, `after-reset-frames.json`, `after-reset-clocks.csv`, and `run.json` (profile, commands, outcome, clock summaries, verdict, bench summary).

| Verdict | Meaning | Action |
|---|---|---|
| lock held | Every sample during the run was at most the locked clocks plus one 15 MHz step | The frame times are a stand-in measurement |
| lock NOT held | A sample exceeded the lock | Discard the run; check the lock lines' output |
| reset `verified` | After the reset, both clocks rose more than 100 MHz above the lock under load | The card is back to normal |
| reset `graphics-only` | The graphics clock rose, the memory clock was not seen above the lock | Check with `status` under load; run `reset` if needed |
| reset `not-verified` | Neither rose | Run `npm run standin -- reset`, or reboot; locks never survive a reboot |

Report a stand-in result with its target, profile source, backend and adapter, and the bench summary (average fps, p95, 1% low), and always call it a stand-in measurement, not a laptop measurement.

## Correct vs. Incorrect

**Incorrect:** an agent adding a sudoers rule so it can lock the clocks unattended.
**Correct:** the agent runs `plan`, shows it, and the machine's owner runs `run` in their terminal.
**Why:** clock locks change the system for every program, and sudo rules are the owner's decision.

**Incorrect:** "the client holds 45 fps on an Iris Xe laptop" from a stand-in run.
**Correct:** "on the Iris Xe stand-in (profile tuned against <laptop>), WebGPU, 1280×720: 45 fps average, 1% low 31 fps".
**Why:** the stand-in approximates a laptop; it does not reproduce shared memory, power sharing or the laptop's driver.

**Incorrect:** locking a graphics clock the card does not offer with the chosen memory clock.
**Correct:** pick both from `nvidia-smi -q -d SUPPORTED_CLOCKS`; the preflight checks the pair.
**Why:** the driver rejects or silently rounds an unsupported value, so the run measures a different machine.

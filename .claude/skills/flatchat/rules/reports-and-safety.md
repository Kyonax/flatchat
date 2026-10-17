---
title: Reports and Safety — Reports With Evidence and the Voice Clip, the Public Form, the Triage Queue, Under-Age Reports, Keeping and Purging Evidence
impact: CRITICAL
impactDescription: A voice clip that leaves a player's computer without a report, a report queue that hides threats behind spam, evidence kept forever or lost too soon, or an under-age report that changes nothing breaks the promises the platform makes to minors and to the people who report.
tags: reports, report, S3.02, OQ-12, OQ-18, cl-013, ClipRecorder, takeClip, clip, voice clip, rolling buffer, WAV, CLIP_SECONDS, CLIP_RATE, buildReport, ReportDraft, ReportEvidence, reportOf, ReportForm, my reports, receipt, decision, public form, /report, REPORT_CATEGORIES, csam, grooming, threats, intimate, underage, harassment, URGENT, triage queue, priority, reportQueue, decideReport, underage-confirmed, underage-cleared, deleteAccount, KEEP_DAYS, purgeReports, keep_until, purged, CLIP_MAX, bodyLimit, media-src, T20
---

Reports (S3.02) carry evidence to the core's owner, who decides on the admin page's triage queue (S3.07). The player is told a receipt at once and the decision later.

## Where It Lives

| Piece | File | What |
|---|---|---|
| The clip recorder | `apps/client/src/renderer/src/voice/clip.ts` | `ClipRecorder`: every decoded 20 ms frame the voice chain plays (`chain.recorder`, fed in `nextFrame` before the frame is transferred), kept at 16 kHz with its speaker and time, for `CLIP_SECONDS` (15); `takeClip(now)` mixes them into one WAV and lists who spoke when |
| The report builder | `apps/client/src/renderer/src/world/report.ts` | `buildReport(draft, evidence, recorder, now, wall, who)`: the only caller of `takeClip`, and only while the player keeps the box ticked |
| Evidence | `WorldSession.reportOf(draft, instance)` | The world (id, name, instance), the last 50 chat lines with their times, who was near with distances, the visit's times, and the speakers of the clip by account |
| UI | `ui/ReportForm.vue`, the People panel's Report, the menu's Report this world, `HomeView.vue`'s Your reports | Hidden in offline worlds (no core) |
| Bridge | `flatchat:report`, `flatchat:reports` (preload, main `index.ts`, `core-api.ts`: base64 of the clip) | |
| Core | `apps/core/src/reports.ts`, migration 0006, routes in `app.ts` | `fileReport`, `myReports`, `reportQueue`, `decideReport`, `deleteAccount`, `reportClip`, `purgeReports`, `cleanEvidence` |

## The Rules

| Rule | Why |
|---|---|
| Only `world/report.ts` calls `takeClip` (T20, error in `apps/client/src/`; tests may call it) | OQ-18: the clip of what a player heard leaves their computer only inside a report they send. The recorder lives in memory, is cleared with the session and is never sent, logged or stored otherwise |
| The clip is a WAV (16 kHz mono 16-bit) of at most `CLIP_MAX` (700 KB); the core refuses anything else (`bad-clip`); `POST /api/v1/reports` alone lifts the core's 16 KB body limit | A browser plays it on the admin page (`<audio>`, `media-src 'self'` in the page policy); no other route takes large bodies |
| Categories: `csam`, `grooming`, `threats` (priority 0, hours), then `intimate`, `underage`, `harassment`, `other` (days) | S3.07's queue order |
| A report that an account is `underage` suspends it at once (reason shown, appealable); the owner deletes it (`underage-confirmed`: its worlds too) or lifts it (`underage-cleared`) | cl-013: an under-age account must not keep playing while it is checked |
| Evidence is kept `KEEP_DAYS` (183; 365 for abuse material and grooming, S3.12), then `purgeReports` (at start and every six hours) clears the text, evidence, clip and contact and keeps the category, the decision and the dates | Data minimisation with the evidence kept long enough to act |
| The public form (`/report`, both languages, five per address per ten minutes) takes reports without an account, with an optional contact | OQ-12 |
| Reports are rate-limited per account (ten, then one every six minutes) | One person cannot flood the queue |

## Correct vs. Incorrect

**Incorrect:** sending the last seconds of voice along with something else, or for diagnostics.
```ts
void bridge.voiceReport({ stats: chain.stats(), clip: this.recorder.takeClip(performance.now()) });
```
**Correct:** only `buildReport` takes the clip, and only for a report the player sends with the box ticked.
```ts
const clip = draft.withClip ? recorder?.takeClip(now) : undefined;
```
**Why:** players were promised that what they hear leaves their computer only in their own report (OQ-18); the trap linter enforces it (T20).

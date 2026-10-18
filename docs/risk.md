# Risk assessment

The written risk document of step S7.02: the illegal-content risks, the risks to children with a children's access assessment, and a data protection impact assessment, for the closed test. It is internal, and a draft for the owner and the lawyer (OQ-19). Written on 2026-10-18 against the code at that date; every mitigation names the file that implements it. The user-facing documents are indexed in [policies.md](policies.md).

## 1. The service and the assumptions

- **The core** (`apps/core`) runs on the owner's home PC, bound to 127.0.0.1 behind a Cloudflare Tunnel ([hosting.md](hosting.md)), with PostgreSQL and a local file store (`apps/core/src/store.ts`). It holds accounts, worlds, uploads, the gallery, reports and moderation.
- **Worlds** (`apps/world-server`) run on their hosts' own PCs, anywhere. Players connect to them directly over WebRTC or UDP (or through TURN). A world receives the connect token's facts (`apps/core/src/worlds.ts` `claimsFor`), the player's IP address, voice, chat, position and outfit, and keeps its own SQLite database (`apps/world-server/src/world/store.ts`).
- **The client** (`apps/client`) is an Electron app. It keeps settings, the encrypted refresh token and a content cache on the player's PC, holds chat and the last 15 seconds of heard voice in memory only, and sends no telemetry.

Assumptions for the likelihoods below:

- Sign-up is by invitation (`FLATCHAT_CORE_SIGNUP=invite`, the default in `apps/core/src/config.ts`).
- The testers are tens to low hundreds of people from the owner's circle and community.
- Minors are off (`FLATCHAT_CORE_MINORS`, off by default: sign-up admits adults only, `apps/core/src/age.ts` `minors-not-yet`). Where a row depends on teens being admitted, it says so.

Likelihood is Low, Medium or High **for this closed test**. Impact is Low, Medium, High or Severe.

## 2. Illegal-content risks

| Kind | Where it can appear | Likelihood | Impact | Mitigations in the code | Gaps |
|---|---|---|---|---|---|
| Child sexual abuse material | Uploaded textures (avatars, items, overlays); world files a host serves; chat; voice | Low | Severe | Urgent queue: `URGENT`, priority 0, kept 365 days (`apps/core/src/reports.ts`). The abuse path (`apps/core/src/abuse.ts` `openAbuseCase`): a world loses its approval and its sessions end (`hosts.revoke` in `apps/core/src/app.ts`); an account is banned; the evidence is sealed with AES-256-GCM for `PRESERVE_DAYS` (365); drafts are made for Te Protejo, CAI Virtual, NCMEC and the NCA. No web route serves sealed evidence (trap T21). Removal everywhere (`apps/core/src/takedowns.ts` `removeContent`); re-uploads caught by fingerprints (`apps/core/src/copies.ts`, `packages/content/src/fingerprint.ts`); overlays rewritten as one still frame (`tools/converter/src/overlay.ts`); the viewer's safe-mode key. The drill: `admin abuse drill` | No hash matching: PhotoDNA is pending, so textures are reviewed by hand. NCMEC registration is pending (the owner's step). Every draft is filed by hand. World content goes from the host to players without the core seeing it, and builders can replace it after approval (`apps/world-server/src/world/uploads.ts`) |
| Grooming and sexual contact with minors | Voice, chat, friend requests, private zones, overlays shared with others | Low while minors are off; Medium once teens are admitted | Severe | Teens are off by default (`config.ts`). A teen joins no world before a guardian authorizes it (`apps/core/src/guardians.ts`; `connectToken` answers `guardian-pending` in `worlds.ts`). Voice and chat stay friends-only on the world server (`apps/world-server/src/server.ts` `mayReach`) and again in the teen's own client (`apps/client/src/renderer/src/world/session.ts` `mayRead`). Nobody can send a teen a friend request (`apps/core/src/social.ts` `befriend`). The microphone starts muted (`session.ts` `loadSocial`). A teen's voice range and gain are capped (`server.ts` `updateVoice`). Worlds learn only `under18`. Grooming reports are urgent and kept 365 days. Blocks work both ways. The guardian sees and removes friends (`/guardian`) | A teen may send a request to any adult it sees, and the adult may accept (`befriend`). Age is self-declared (birth month and year), and the guardian check is an emailed link. The protections run on the host's world server, so a modified server could drop them: the client filter still holds voice and chat, but not avatars, emotes or overlays. Grooming has no sealed case and no draft for the authorities |
| Intimate images shared without consent | Textures, overlays, world files | Low | High | The `intimate` category. The abuse path's `intimate` kind removes at once and logs the 48-hour clock (`abuse.ts` `TAKE_DOWN_HOURS`, `logClock`). Removal everywhere, and fingerprints | Fingerprints catch only re-uploads of something already taken down. No hash list that victims can submit to |
| Threats, incitement, violent extremism | Chat, voice, display names, world names | Low to Medium | High | `threats` is urgent (`reports.ts`). Worlds can kick, mute and ban, with a reason (`apps/world-server/src/world/store.ts`; [hosting.md](hosting.md#moderation-and-appeals)). Platform suspensions and bans with a statement of reasons and an appeal (`apps/core/src/moderation.ts`). World revocation. The emergency clause of the law enforcement policy | No logs: the only evidence is what a reporter sends. No written escalation to the police for threats |
| Hate speech and harassment | Chat, voice, names, avatars | Medium | Medium | Reports. Personal mutes (`apps/core/src/mutes.ts`). Two-way blocks (`social.ts`; `server.ts` `apart`). Earmuffs and the safe-mode key. World moderation. Platform decisions with appeals. Chat is capped at 280 characters, 5 lines and then one every 1.5 s (`server.ts`) | No warning step. Display names are checked for characters only, not words (`apps/core/src/accounts.ts` `cleanDisplayName`) |
| Copyright infringement (ripped avatars, game assets) | Avatars, items, overlays, world files | High (common among avatar makers) | Medium | The takedown form and its status page (`takedowns.ts`; `/takedown` in `app.ts`). Removal everywhere. Fingerprints checked against what was removed and against closed gallery entries (`copies.ts`). Exact copies refused (`apps/core/src/gallery.ts` `copyRefused`). Licence fields that may only be stricter (`packages/content/src/licence.ts`). Strikes listed for a ban (`copies.ts` `struckAccounts`). The project's own assets are CC0 or CC BY (AGENTS.md rule 8) | No counter-notice for the uploader. No threshold for repeat infringers. Emotes, dances and their sounds have no takedown path (`removeContent` covers only avatars and items; the `animations` table has no `removed` status) and no fingerprint. Whether Colombian law gives any safe harbour is for the lawyer |
| Fraud, scams, phishing | Chat, world text, overlays | Low | Medium | No payments and no marketplace. Strangers' text is inert (AGENTS.md rule 4; traps T05 and T06). Sign-in happens only in the system browser (`apps/core/src/sessions.ts`), so a world cannot ask for the password inside the client. Passwords never reach worlds | A link in chat still shows as text, and a world's overlay can still advertise a scam |
| Doxxing; hosts misusing IP addresses | The host's PC; plugins; chat | Medium (every host sees its visitors' IP addresses) | Medium to High (location, attacks on a home connection) | The core stores no IP address. Worlds never receive email, birth date or country (`claimsFor`). TURN relays exist. Host agreement rule 1 (no recording) | The host agreement says nothing about IP addresses or other personal data. `--relay-only` is a command-line flag, not a setting (`apps/client/src/main/flags.ts`). The WebRTC offer relayed through the core (`apps/core/src/hosts.ts`) carries the player's ICE candidates, because the client gathers all of them (`apps/client/src/renderer/src/net/connection.ts`, `iceTransportPolicy: 'all'`) |
| Hostile files (exploits against the converters or clients) | Uploads, world files | Medium | High | Sandboxed converters (`apps/core/src/sandbox.ts`). Every format is rewritten. The world validator refuses external URIs (`packages/content`). The client loads only the platform's own format (trap T11). Players never download plugins ([plugins.md](plugins.md)) | Plugins run inside the world server's process with the host's rights: a risk to hosts, not players |

## 3. Children

### 3.1 Children's access assessment

| Question | Answer, with the code |
|---|---|
| Could children under 13 use it? | They are refused (`age.ts`, under 13 everywhere). The question gives no hint of the limit. An age refusal spends the invitation (`accounts.ts` `signUp`) and sets a 30-day cookie, so a second try in that browser gets the same answer (`app.ts`). A doubtful month counts as the younger age (`age.ts` `ageOn`). Self-declaration is the only check, and 3D social platforms attract under-13s who lie about their age |
| Could teens (13 to 17) use it? | Yes, by design, once `FLATCHAT_CORE_MINORS=on`: only with a guardian (`guardians.ts`), from 16 in Australia, and never yet in Brazil (`age.ts`) |
| What happens when an under-age account is found? | A report in the `underage` category suspends it at once (`reports.ts` `fileReport`). If confirmed, the account and its worlds are deleted (`decideReport`, `deleteAccount`) |
| Conclusion | Child access is Low today: the test is invitation-only and adults-only. It becomes Medium once teens are admitted or sign-up opens. Treat FlatChat as a service likely to be used by children from the moment `FLATCHAT_CORE_MINORS` is on |

### 3.2 Risks to children

| Area | Risk | Mitigation in the code | Residual |
|---|---|---|---|
| Content | Sexual content, nudity or violence in worlds, overlays or avatars | The content rule (no sexual content or nudity, OQ-11; standard bodies always wear underwear, `packages/content/src/layers.ts`). Removal everywhere. Overlays worn "for others too" show only for viewers who allowed that wearer ([overlays.md](overlays.md)). Viewers can switch worlds' overlays off. The safe-mode key | World content is not reviewed after approval. No rule yet on graphic violence |
| Contact | Strangers reaching a teen | Friends-only voice and chat (server and client). No incoming friend requests. Two-way blocks. The guardian's page | Requests a teen sends itself. Avatars and emotes stay visible to strangers |
| Conduct | Bullying among friends; teens sharing their own personal data | Reports, blocks and mutes; the rules | No chat filter |
| Commerce | Purchases, ads, profiling | None exist: no payments, no ads, no analytics | Low |
| Data | A teen's data sent to world servers abroad | The token says only `under18` and carries the teen's friends (`social.ts` `tokenLists`). The guardian's express authorization for servers abroad (`guardians.ts` `authorize`, the `abroad` field) | Hosts still see the teen's IP address, voice (to friends), chat and position |

### 3.3 To close before `FLATCHAT_CORE_MINORS=on`

1. **Withdrawing a guardian's authorization:** the guardian pages promise it "by writing to the contact", but no code does it. `guardians.ts` has no revoke; today the owner would suspend the teen by hand.
2. **The link at 18:** the guardian link does not end. `teensOf` and `guards` (`guardians.ts`) never check the teen's age, so a guardian keeps seeing and removing an adult's friends.
3. **The "everyone" choice:** the client ignores it. `session.ts` `mayRead` keeps a minor to friends and never reads `contact`. That is stricter than the guardian page says, not looser.
4. **Friend requests a teen sends:** a teen can send one to anyone (`befriend`). Decide whether a guardian approves new friends, or whether requests go only to people the teen has met.
5. **Unanswered requests:** guardian requests that nobody answered, and teen accounts waiting for authorization, are never cleaned up (`guardian_links`, `guardian_steps`).
6. **Outside steps:** NCMEC registration; PhotoDNA or another hash list; a written escalation for grooming.
7. **Review:** the lawyer reviews the teen and guardian pages. Bump `SUMMARY_VERSION` (`guardians.ts`) when the guardian summary in `strings.ts` follows the new guardian page.

## 4. Data protection impact assessment

### 4.1 The processing

- **Controller:** the operator, a natural person in Colombia (Ley 1581 de 2012, Decreto 1377 de 2013).
- **Data subjects:**
  - players (adults and teens), guardians and hosts;
  - people who report on the public form, and rights holders who ask for takedowns;
  - people who only appear in evidence: players near a report, and voices in a clip.
- **Data in the core:** every table in `apps/core/src/migrations/`:
  - `accounts`, `consents`, `invitations`, `sessions`, `login_requests`, `admin_sessions`;
  - `worlds`, `world_events`, `favourites`;
  - `moderation_actions`, `appeals`, `appeal_tokens`, `world_unbans`, `reports` (with the voice clip);
  - `personal_mutes`, `friends`, `friend_requests`, `blocks`, `email_verifications`;
  - `guardian_links`, `guardian_steps`, `guardian_sessions`;
  - `abuse_cases`, `abuse_forms`;
  - `avatars`, `items`, `outfits`, `gallery`, `animations`, `takedowns`, `strikes`.

  Outside the database: the file store (`store.ts`) and the core's JSON log (`apps/core/src/main.ts`: method, route, status and time per request; a few events with an account or world id; never a body, a query, a token or an address).
- **Data on each host's PC:** `places`, `roles`, `bans`, `mutes`, `moderation` and the plugins' `kv` (`apps/world-server/src/world/store.ts`), plus whatever plugins log.
- **Recipients:**
  - world servers: the token fields (`packages/protocol/src/schema.ts` `TOKEN_CLAIMS`), plus the IP address, voice, chat, position and outfit;
  - other players: name, avatar, items, voice, chat and position;
  - processors: Cloudflare (Tunnel, STUN, optional TURN), the host of the owner's coturn relay, Resend (mail) and the host of kyonax.com (downloads and the update feed).
- **Transfers abroad:** hosts can be anywhere. The processors are probably in the United States (to confirm).

Retention as the code has it:

| Data | Kept | Where |
|---|---|---|
| Report evidence (text, chat, nearby players, speech times, clip, target reference, contact) | 183 days; 365 for CSAM and grooming; then cleared | `reports.ts` `KEEP_DAYS`, `purgeReports`, run at start and every 6 h (`app.ts`) |
| Purged report shell (reporter, target, category, decision, dates) | No end | `reports.ts` |
| Sealed abuse package | 365 days; the case row stays | `abuse.ts` `PRESERVE_DAYS`, `purgeCases` |
| Accounts and everything tied to them | While the account exists; deleted only for a confirmed under-age report | `reports.ts` `deleteAccount` |
| Sessions, login requests, email verifications, guardian steps and sessions, admin sessions | Expired rows are never deleted (except appeal tokens) | `sessions.ts`, `verify.ts`, `guardians.ts`, `admin-web.ts`, `moderation.ts` |
| Upload files | Never deleted: deleting an upload only sets `deleted_at` | `store.ts`, `avatars.ts`, `items.ts`, `animations.ts` |
| Fingerprints of what was taken down | No end (they catch copies) | `copies.ts` |
| Moderation actions, appeals, strikes, takedowns | No end | `moderation.ts`, `copies.ts`, `takedowns.ts` |
| A refused sign-up | Nothing the person typed. The invitation is marked refused and keeps the email the owner typed when making it, if any. The browser keeps a 30-day cookie | `accounts.ts`, `app.ts` |
| The core's log | Wherever stdout goes: not set | `main.ts` |
| Rate-limit keys (IP addresses, emails) | In memory only, forgotten on restart | `apps/core/src/limits.ts` |

### 4.2 Necessity and proportionality

- **Minimisation:**
  - Birth month and year only, never the day (`accounts.ts`). Worlds get `under18` and never email, birth date or country (`worlds.ts` `claimsFor`, `age.ts` `isMinor`). An adult's friends never reach a world (`social.ts` `tokenLists`).
  - No IP address is stored. Tokens are kept as SHA-256 digests (`apps/core/src/secrets.ts`).
  - TURN usernames carry the account id, never the email (`apps/core/src/ice.ts`). Mail addresses and links never reach the log (`apps/core/src/mail.ts`).
  - Evidence is cut to known fields and sizes (`reports.ts` `cleanEvidence`). The voice clip leaves the client only in a report (trap T20, `apps/client/src/renderer/src/world/report.ts`).
- **Purpose:** no advertising, analytics or profiling exists anywhere in the code.
- **Legal basis:**
  - Each account's authorization is recorded with the notice's version (`accounts.ts` `signUp` writes `consents` with `NOTICE_VERSION`).
  - A teen's comes from the guardian (`guardians.ts` `authorize` writes a `guardian-authorization` consent), after the teen's own agreement (`teen_agreed_at`).
  - The basis for processing data about people who did not consent (the reported, bystanders, voices in clips) is for the lawyer.
- **Storage limits:** only report evidence and abuse packages expire (4.1). Everything else needs a schedule.
- **Rights:** there is no self-service access, export or deletion. Requests are handled by hand, and the admin command line has no command for them.

### 4.3 Risks to the people concerned, and measures

| Risk | Likelihood | Severity | In place | Further measures |
|---|---|---|---|---|
| Hosts misuse visitors' IP addresses, voice or chat | Medium | High | Host agreement (no recording); approval by the owner; revocation with the reason (`worlds.ts` `revokeWorld`, `hosts.revoke`) | Add a personal-data clause to the host agreement (IP addresses, no sharing, no logs beyond moderation). Make relay-only a player setting. Decide the host's role (independent controller or not) |
| A breach of the core's database or store on the home PC | Low | High | Argon2id passwords; token digests; world keys and evidence sealed under the core's secret; listening on 127.0.0.1 behind the tunnel; store files written 0600 (`store.ts`) | Disk encryption, encrypted backups, and a breach procedure that includes telling the SIC (Ley 1581 art. 17) |
| Losing `FLATCHAT_CORE_SECRET` | Low | High (sealed evidence and world keys cannot be opened) | [hosting.md](hosting.md) says to back the secret up with the database | Write down where the secret's backup lives |
| Voice clips capture bystanders | Medium | Medium | 15 seconds at most; an opt-out box; playback only on the admin page; purged with the evidence | The lawyer decides whether the box may start ticked (`apps/client/src/renderer/src/ui/ReportForm.vue`, `withClip = ref(true)`), and whether a clip is sensitive (biometric) data |
| Data kept too long | High | Medium | Purges for reports and abuse cases | A retention schedule and a cleanup job for sessions, login requests, verifications, guardian rows, deleted uploads' files, purged report shells and the log |
| Access and deletion requests cannot be met within the legal times | Medium | Medium | By hand | Admin commands for export and deletion; a way to mark "reclamo en trámite" |
| A false under-age report suspends an adult at once | Medium | Low to Medium | The suspension shows its reason and can be appealed; reports are rate-limited per account (`apps/core/src/limits.ts`) | Watch for reporters who repeat it |
| A guardian keeps powers after the teen turns 18 | Certain once a supervised teen turns 18 | Medium | None | End the link at 18 (3.3) |
| Abuse of the public forms (spam, false takedowns) | Medium | Low | Rate limits per address; the takedown's good-faith statement and signature (`takedowns.ts`) | None |
| Someone takes over the admin page | Low | High | Its own 12-hour cookie with SameSite=Strict, CSRF tokens, the admin flag, rate-limited sign-in (`apps/core/src/admin-web.ts`, `app.ts`) | A second factor for admin accounts |
| A world server hears voice by design | Certain | Medium | Voice is forwarded and never stored; the host agreement forbids recording | None in the MVP: no end-to-end encryption between players |

### 4.4 Conclusion

For an invitation-only, adults-only closed test, the residual risk is acceptable once the documents' "[TO DECIDE: …]" points are settled and the processors are named in the notices. Opening sign-up or admitting teens is not acceptable until the gaps in 3.3 are closed and the retention schedule in 4.3 exists.

## 5. What to revisit before big changes

Revisit sections 2 to 4, and the user documents in `apps/core/src/documents.ts`, before any of these:

- opening sign-up (`FLATCHAT_CORE_SIGNUP=open`), admitting teens (`FLATCHAT_CORE_MINORS=on`) or opening to the public;
- changing the age rule or its countries (`age.ts`);
- changing what a world learns (`TOKEN_CLAIMS` in `packages/protocol/src/schema.ts`, `claimsFor`), which is the privacy notice's "What a world receives";
- any new kind of personal data: direct messages, groups, recordings, screenshots, video or streams, text-to-speech, location, contacts;
- a new processor (mail, TURN, the R2 store, crash reports) or moving the core off the home PC;
- payments, ads, a marketplace or any profiling;
- changing the retention periods (`KEEP_DAYS`, `PRESERVE_DAYS`) or the abuse path (run `admin abuse drill` after any change, as the core's README says);
- new plugin permissions, or a plugin sandbox that changes what hosts can read;
- turning on PhotoDNA, or registering with NCMEC (update the law enforcement policy).

When the documents change, bump `DOCUMENTS_VERSION` (`documents.ts`). When the privacy notice changes, bump `NOTICE_VERSION` (`accounts.ts`), because each account's consent names the version it accepted. Bump `SUMMARY_VERSION` (`guardians.ts`) for the guardian summary, and `HOST_AGREEMENT_VERSION` (`moderation.ts`) for the host agreement, which asks every host to accept again.

# Rules and policies

The documents a FlatChat core serves to players, guardians, hosts, rights holders and authorities (step S7.02 of the MVP plan). They are **drafts for the lawyer's review (OQ-19)**: nothing here is final legal text until the lawyer has checked it, and none of it is served to the public while a `[TO DECIDE: …]` note remains. The internal risk document is [risk.md](risk.md).

## Where they live

- **The text:** `apps/core/src/documents.ts`. `DOCUMENTS[lang][id]` is a `Doc`: a title, a one-line summary and sections, each with a heading and plain-text paragraphs. A paragraph that starts with `• ` is a list item. Both languages (`en`, `es`) hold the same documents with the same number of sections and paragraphs. `DOCUMENTS_VERSION` is `2026-10-18`.
- **The paths:** `POLICY_PAGES` in `packages/content/src/policies.ts`, shared by the core and the client. The client lists them under Help, "Rules and policies" (`apps/client/src/renderer/src/ui/HelpView.vue`), and opens them in the system browser from its own core.

| Id | Title (EN / ES) | For | Path | Sections |
|---|---|---|---|---|
| `rules` | Community rules / Reglas de la comunidad | Everyone: what is not allowed, what happens, appeals, how to report, how to protect yourself | `/rules` | 9 |
| `terms` | Terms of use / Términos de uso | Account holders and hosts: the closed test, accounts and age, uploads and the licence they grant, the gallery, hosting, no warranty, ending, changes, law | `/terms` | 11 |
| `privacy` | Privacy notice / Aviso de privacidad | Everyone: the full notice that replaces the short one at `/privacy` | `/privacy` | 16 |
| `dataPolicy` | Data processing policy / Política de Tratamiento de la Información | Colombian law: the policy Decreto 1377 de 2013, article 13, requires. Written for Spanish first; the English text is a translation and says so | `/data-policy` | 12 |
| `teens` | FlatChat for teens / FlatChat para adolescentes | Players aged 13 to 17, one page (about 360 words) | `/teens` | 4 |
| `guardians` | FlatChat for parents and guardians / FlatChat para madres, padres y tutores | Guardians, one page (about 350 words) | `/guardians` | 4 |
| `lawEnforcement` | Law enforcement policy / Política para autoridades | Authorities: legal process, emergencies, preservation, what exists, child safety, records and notice | `/law-enforcement` | 7 |

Pages that already exist outside `documents.ts`:

- **The host agreement** at `/host-agreement`: `agreement` in `apps/core/src/strings.ts`, version `HOST_AGREEMENT_VERSION` (1) in `apps/core/src/moderation.ts`.
- **The report form** at `/report`, and **the takedown form** at `/takedown` with its status page `/takedown/status`.
- **The guardian's summary** on `/guardian/invite`: `guardianSummary` in `strings.ts`, version `SUMMARY_VERSION` in `apps/core/src/guardians.ts`.

### Article 13 of Decreto 1377 de 2013, item by item

| Item | Section of `dataPolicy` |
|---|---|
| 1. The controller's name, address, email and phone | Responsable del tratamiento |
| 2. The processing and its purposes | Tratamiento y finalidades (with Datos de niñas, niños y adolescentes, and Encargados y transferencias) |
| 3. The data subject's rights | Derechos de los titulares |
| 4. Who handles petitions, queries and claims | Responsable de peticiones, consultas y reclamos |
| 5. The procedure to exercise the rights | Consultas (Ley 1581 art. 14: 10 business days, extendable by 5) and Reclamos (art. 15: 15 business days, extendable by 8) |
| 6. The effective date and the databases' validity period | Vigencia |

## Serving them

- **Routes.** No route serves `/rules`, `/terms`, `/data-policy`, `/teens`, `/guardians` or `/law-enforcement` yet. `/privacy` still serves the short notice (`privacyPage` in `apps/core/src/pages.ts`). A page renders a `Doc` through `html` (so everything is escaped), each paragraph as a `<p>`, and `• ` paragraphs as list items. It picks the language with `pickLang`.
- **Placeholders.** They are filled at serve time:
  - `{operator}` and `{contact}` come from `FLATCHAT_CORE_OPERATOR` and `FLATCHAT_CORE_CONTACT` (`apps/core/src/config.ts`).
  - `{address}`, `{phone}` and `{effective}` have no setting yet. Two new settings (for example `FLATCHAT_CORE_ADDRESS` and `FLATCHAT_CORE_PHONE`) and the date the owner publishes the documents are needed.
  - Fill them with `replaceAll`. No paragraph uses a placeholder twice today, but `privacyPage`'s `replace` fills only the first.
- **Notes.** Every `[TO DECIDE: …]` is in English in both languages, word for word the same, so the owner and the lawyer read one list. A check before serving should refuse any text that still contains `[TO DECIDE:`.
- **Versions.** When `/privacy` switches to this notice:
  - Bump `NOTICE_VERSION` in `apps/core/src/accounts.ts`: each account's consent records the notice version it accepted.
  - Decide whether existing accounts accept the new notice.
  - Bring `guardianSummary` in `strings.ts` in line with the guardians page, and bump `SUMMARY_VERSION`.

## What the lawyer must check

**All documents**

- **Accuracy:** every fact about storage and moderation was checked against the code on 2026-10-18 ([risk.md](risk.md) names the files).
- **The operator:** their legal identity, ID number, address and phone.
- **Spanish register:** the Spanish uses tú, as the core's pages do; the authorities' policy is written impersonally.

**rules**

- **Completeness:** is the list of forbidden conduct complete for Colombian law, including the duties of online services toward minors (Ley 679 de 2001 and Ley 1336 de 2009)?
- **Process:** are the sanctions proportionate, and are the statement of reasons and the appeal enough?
- **Licence fields:** the content rule (no sexual content or nudity) overrides the VRM licence field `allowExcessivelySexualUsage`, which the gallery still records (`packages/content/src/licence.ts`).

**terms**

- **Acceptance:** sign-up records only the privacy authorization (`consents`, `NOTICE_VERSION`), never acceptance of the terms.
- **Teens:** whether a teen can accept them, or the guardian does on the teen's behalf.
- **Uploads:** the scope and length of the licence users grant, and authors' moral rights (Decisión Andina 351 de 1993, Ley 23 de 1982).
- **No warranty:** the disclaimer and the limit of liability under Ley 1480 de 2011 (Estatuto del Consumidor), even for a free service.
- **Jurisdiction:** which city's courts.
- **Hosts:** whether a host is an independent controller of what its world receives, and whether the host agreement must say more about personal data. Today it says nothing about IP addresses.
- **Takedowns:** a notice-and-takedown process with no statutory safe harbour that we know of, and no counter-notice.

**privacy**

- **Contents:** the duty to inform (Ley 1581 art. 12), and the contents of an aviso de privacidad (Decreto 1377 arts. 14 and 15).
- **Legal basis:** for data about people who did not consent: the reported, bystanders in evidence, and voices in a clip.
- **Voice clips:** whether a clip is sensitive (biometric) data under Ley 1581 art. 5, and whether its box may start ticked.
- **Abroad:** transfers (Ley 1581 art. 26, and the SIC's list of countries with adequate protection) and transmissions to processors, which need contracts (Decreto 1377 art. 25, now in Decreto 1074 de 2015).
- **The rest:** the cookie wording; breach notification to the SIC (Ley 1581 art. 17).

**dataPolicy**

- **Citations:** the article numbers cited, and the reference to Decreto 1074 de 2015.
- **Registration:** whether the operator must register the databases in the Registro Nacional de Bases de Datos.
- **"Reclamo en trámite":** no code can mark a record with this legend; the owner would do it by hand.
- **The translation:** the clause saying the Spanish text governs.

**teens**

- **Reading level:** is it plain enough for a 13-year-old?
- **Helplines:** are 123 and the ICBF's line 141 right and current?
- **Being heard:** does the page reflect the teen's right to be heard (Decreto 1377 art. 12)?

**guardians**

- **Who authorizes:** the authorization comes from the legal representative, and the only identity check is an emailed link to the address the teen named.
- **Abroad:** the express authorization for world servers abroad.
- **Withdrawal:** the withdrawal mechanism, which the code does not have.

**lawEnforcement**

- **Disclosure:** the basis for disclosure (Ley 1581 arts. 10 and 13); the basis for emergency disclosure, which article 10's medical or sanitary urgency may not cover.
- **Preservation:** the powers behind preservation requests.
- **Abroad:** the channels for foreign requests.
- **Notice:** notifying users, and not tipping off the target of an abuse case.
- **Child safety:** NCMEC registration for a provider outside the United States, and Ley 679 de 2001's duty to report.

## Facts the code cannot give

The owner supplies these; most are `[TO DECIDE: …]` notes in the documents:

- the operator's address and phone;
- the effective date;
- each processor's legal name and country: Cloudflare, the coturn relay's host, Resend, and the host of kyonax.com;
- where backups are kept, and for how long;
- how long the core's log is kept;
- the NCMEC registration;
- the city whose courts hear disputes.

## Found while drafting

**The short notice** (`privacy` in `strings.ts`) does not match the code:

- **What worlds receive:** its list leaves out the tester flag, the worn avatar's reference and the `contact` field. The token carries all three, and `contact` goes for every account (`packages/protocol/src/schema.ts` `TOKEN_CLAIMS`).
- **What is kept:** it leaves out friends and friend requests, blocks, mutes, favourites, active days, emotes, dances and their sounds, outfits, reports and their voice clips, and strikes.
- **What it never says:**
  - that a world's host receives the IP address, voice, chat and position;
  - that each world keeps its own database;
  - the processors, and transfers abroad for adults;
  - any retention period.

**The guardian summary** (`guardianSummary` in `strings.ts`) says less than the code does:

- **What worlds learn:** it says worlds learn only the display name, the under-18 flag, the friends and the blocks. They also get the account number, trust level, tester flag, confirmed-email flag, account age, whether the world is the teen's, the worn avatar and the `contact` choice.
- **What is kept:** it leaves out sessions, blocks, mutes, uploads and voice clips.
- **Withdrawal:** it promises withdrawal by writing to the contact, and no code does it.

**Gaps in the code**, each a `[TO DECIDE: …]` or a section of [risk.md](risk.md):

- **No deletion:** an account cannot be deleted on request. `deleteAccount` runs only for a confirmed under-age report.
- **No cleanup:** expired sessions, login requests, verifications and guardian rows are never cleaned up, and the file store never deletes files.
- **Teens:** the guardian link does not end at 18, and the client ignores a guardian's `everyone` choice.
- **Emotes and dances:** they have no takedown path and no fingerprint.
- **Moderation:** there is no warning step, and removed content cannot be appealed.
- **Authorities:** there is no record of authorities' requests, and no legal hold (`purgeReports` runs whatever an authority asked).
- **Refused sign-ups:** the invitation keeps the email the owner typed when making it. The header of `apps/core/src/age.ts` says nothing is kept.

**Smaller points:**

- `moderation.ts` points to `docs/host-agreement.md`, which does not exist: the agreement lives in `strings.ts`.
- The Spanish interface uses *bloquear* for a player's block and for a ban (`bannedSince` in `strings.ts`; `moderation.ban*` in the client's `es.ts`). The documents keep that wording, but *vetar* for bans would read less ambiguously.
- The client labels the guardians page "Para acudientes". The documents and the core's pages say "madre, padre o tutor".

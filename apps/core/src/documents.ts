// SPDX-License-Identifier: AGPL-3.0-or-later
// The rules and policies the core serves (S7.02), as data, in English and Spanish: the community
// rules, the terms of use, the full privacy notice, Colombia's data processing policy (written for
// Spanish first), one page each for teens and for guardians, and the law enforcement policy.
// These are drafts for the lawyer's review (OQ-19): every "[TO DECIDE: …]" is an open point for the
// owner and must be gone before the documents are served to the public. The placeholders
// {operator}, {contact}, {address}, {phone} and {effective} are filled at serve time. Both
// languages hold the same documents with the same sections; docs/policies.md is the index.

export const DOCUMENT_IDS = ['rules', 'terms', 'privacy', 'dataPolicy', 'teens', 'guardians', 'lawEnforcement'] as const;
export type DocumentId = (typeof DOCUMENT_IDS)[number];

export const DOCUMENTS_VERSION = '2026-10-18';

export interface DocSection {
  heading: string;
  paragraphs: string[];
}

export interface Doc {
  title: string;
  summary: string;
  sections: DocSection[];
}

const en: Record<DocumentId, Doc> = {
  rules: {
    title: 'Community rules',
    summary: 'What is not allowed on FlatChat, what happens when someone breaks a rule, and how to report it.',
    sections: [
      {
        heading: 'The short version',
        paragraphs: [
          'These rules apply everywhere on FlatChat: in every world, in voice and chat, in display names, and in every avatar, item, emote, sound, overlay and world.',
          'Treat people with respect. Keep everything free of sexual content. Do not break the law. If something goes wrong, block, mute or report.',
          'Breaking a rule can cost you a world, an upload or your account. The terms of use add rules for what you upload, and the host agreement for hosting a world.',
        ],
      },
      {
        heading: 'No sexual content or nudity',
        paragraphs: [
          'There is no sexual content or nudity anywhere on FlatChat: not in avatars, items, emotes, sounds, overlays or worlds, and not in chat, voice or names. This holds whatever an upload’s licence fields allow.',
          'Child sexual abuse material is a crime. We remove it at once, ban the account or take the world down, keep the evidence and report it to the authorities.',
          'No adult may seek a minor sexually (grooming): no sexual talk, no asking for pictures, no asking to meet, no asking to keep secrets.',
          'Never share intimate images of anyone without their consent.',
        ],
      },
      {
        heading: 'Respect people',
        paragraphs: [
          '• No harassment or bullying: no insults, no following someone who asked you to stop, no getting others to pile on.',
          '• No hate: no attacks on people for their race, ethnicity, nationality, religion, sex, gender, sexual orientation, disability or illness.',
          '• No threats or violence: no threats to hurt anyone, no encouraging anyone to hurt themselves, no praise for attacks.',
          '• No impersonation: do not pretend to be another player, a host, a moderator, the operator or a public figure.',
          '• No sharing private data: never share someone’s real name, address, phone number, school, photos, IP address or account details without their consent.',
        ],
      },
      {
        heading: 'Play fair and keep it legal',
        paragraphs: [
          '• No illegal content or activity: nothing that breaks Colombian law or the law where you are, such as selling drugs or weapons, fraud, or other people’s work copied without permission.',
          '• No cheating or exploits: no changed app or world server that gets around these rules or the protections for minors, no attacks on servers, no abuse of bugs. If you find a bug, report it.',
          '• No spam or scams: no flooding the chat, no advertising, no links to scams, and never ask anyone for their password.',
          '• No getting around a decision: do not use another account to escape a suspension or a ban, and give your true birth month, year and country.',
        ],
      },
      {
        heading: 'What happens in a world',
        paragraphs: [
          'Each world has an owner, and may have moderators. They can remove you from the world, mute you, or ban you from it for an hour, a day, a week or until they lift the ban. They always give a reason, and you see it.',
          'A world’s ban stays in that world’s records, so leaving and coming back does not undo it. You can appeal to the world’s owner from the app: the owner reads your appeal and decides.',
          'A world may have rules of its own on top of these, never looser ones.',
        ],
      },
      {
        heading: 'What happens on FlatChat',
        paragraphs: [
          'The operator acts for the whole platform. Depending on what happened, we can:',
          '• remove an avatar, an item or an overlay everywhere (each removal is a strike against the account that uploaded it);',
          '• take a world off FlatChat, so nobody can join it;',
          '• suspend an account until we lift the suspension, or ban it. A suspended or banned account can neither sign in nor join a world.',
          'You see the decision and its reason when you sign in. [TO DECIDE: whether formal warnings come before a suspension]',
          'Child sexual abuse material and intimate images shared without consent mean an immediate ban. An account reported as under the minimum age is suspended until we check its age, and deleted if the report is right.',
        ],
      },
      {
        heading: 'Appeals',
        paragraphs: [
          'If you think a suspension or a ban is wrong, sign in: the page shows the decision and a form to appeal it. The person who runs FlatChat reads every appeal, and you see the answer when you sign in again. If we reverse the decision, your account works again.',
          'Appeal a world’s ban to that world’s owner, from the app.',
          '[TO DECIDE: whether a removed avatar or item can be appealed]',
        ],
      },
      {
        heading: 'How to report',
        paragraphs: [
          'In a world, open the People list (Tab), pick the person and choose Report, or use Report this world. Say what it is about and what happened.',
          'A report carries the last 50 chat lines you saw, who was near you and the times. While its box stays ticked, it also carries the last 15 seconds of what you heard; untick it to send the report without sound.',
          'You get a reference like R-XXXX-XXXX, and the answer appears on your home screen. We read every report: child abuse, grooming and threats within hours, the rest within days.',
          'Without an account, use the report form at /report. Is your work copied on FlatChat? Ask for a takedown at /takedown. If someone is in danger right now, call your local emergency number first.',
        ],
      },
      {
        heading: 'Protect yourself',
        paragraphs: [
          'In the People list you can turn someone’s volume down, mute them, hide their avatar, stop their overlays or block them. Mutes and blocks follow your account into every world.',
          'A block works both ways: the two of you stop seeing and hearing each other, and any friendship between you ends.',
          'Earmuffs let you hear only the people close by. Shift+Esc is the safe-mode key: every other avatar becomes a plain figure, and every overlay and effect stops at once.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of use',
    summary: 'The agreement between you and the operator of this FlatChat server, during the closed test.',
    sections: [
      {
        heading: 'Who we are',
        paragraphs: [
          'FlatChat is a social world platform in a closed test. {operator} (“we”) runs this server. Address: {address}. Email: {contact}. Phone: {phone}.',
          'By creating an account or using FlatChat, you accept these terms, the community rules and the privacy notice. [TO DECIDE: whether sign-up asks people to accept these terms]',
          'FlatChat’s code is open source, under the licences its repository states. These terms cover the service this server provides, not the code.',
        ],
      },
      {
        heading: 'A closed test',
        paragraphs: [
          'FlatChat is not finished. During the test you join by invitation, features change, things break, and worlds or data may be reset or lost. [TO DECIDE: whether test accounts and data are wiped when the test ends]',
          'FlatChat is free: no payments, no ads and no tracking.',
        ],
      },
      {
        heading: 'Your account',
        paragraphs: [
          'You must be at least 13. From 13 to 17, a parent or legal guardian must authorize your account before you can play, and this server must be accepting teens: during parts of the test it accepts only adults. In Australia the minimum is 16, and teens in Brazil cannot join yet.',
          'Give your true birth month and year and your country. An account found to be under the minimum age is deleted.',
          'Keep your password to yourself: you answer for what is done with your account. Your display name follows the community rules.',
        ],
      },
      {
        heading: 'What you upload',
        paragraphs: [
          'Once your account reaches trust level 1 (a few days old, with a confirmed email), you can upload avatars, items, emotes and dances with their sounds.',
          'Upload only what you made or have the right to share, and only what follows the community rules: no sexual content or nudity, whatever a file’s licence fields allow.',
          'You keep your rights. You give the operator a free, worldwide permission to store, convert, copy and deliver what you upload, and to show it to the people who see you, while it is on FlatChat and as long as our safety records need it.',
          'When you wear something, the app of every player who sees you downloads its converted files. The file you uploaded is never handed out.',
          'Copies of other people’s work are refused or taken down. We keep the fingerprint of what we take down, so that a copy of it is caught. Each takedown is a strike against the account that uploaded it, and strikes can lead to a ban.',
        ],
      },
      {
        heading: 'The free gallery',
        paragraphs: [
          'From trust level 2, you can publish your own avatars and items in the free gallery. You confirm that it is yours to share and follows the content rules, and you state its licence: every one of VRM 1.0’s terms.',
          'The gallery takes only what everyone may wear. An avatar’s licence can be stricter than its file’s own terms, never looser.',
          'Whoever takes an entry gets their own copy. If you withdraw it, it leaves the gallery, but copies already taken stay. Others may copy it, change it or use it commercially only as far as your licence allows.',
        ],
      },
      {
        heading: 'Hosting a world',
        paragraphs: [
          'Worlds run on their hosts’ own computers. To have a world approved, you accept the host agreement (at /host-agreement): no recordings, reports forwarded, takedowns followed, protections for minors kept.',
          'You answer for your world: its files, its plugins, the builders and moderators you choose, and how its visitors are treated. Your computer receives your visitors’ IP addresses, voice and chat: never record them, and never share them or use them for anything but running the world.',
          'If a host breaks the agreement, we revoke the world’s approval and nobody can join it.',
        ],
      },
      {
        heading: 'Moderation',
        paragraphs: [
          'We may remove content, take worlds down, and suspend or ban accounts that break these terms or the community rules, as the rules describe. You can appeal a suspension or a ban.',
          'We report child sexual abuse material to the authorities, and we answer their valid requests, as the law enforcement policy describes.',
        ],
      },
      {
        heading: 'No warranty during the test',
        paragraphs: [
          'FlatChat is offered as it is, while it is tested. We do not promise that it will always work, that no data will be lost, or that it fits any purpose.',
          'As far as the law allows, we are not responsible for losses caused by outages, lost data, other players or the worlds that hosts run. Nothing here takes away rights the law gives you that cannot be waived.',
        ],
      },
      {
        heading: 'Ending your account',
        paragraphs: [
          'You can stop using FlatChat at any time, and ask us to delete your account by writing to {contact}. [TO DECIDE: how an account is deleted on request and what stays]',
          'We may suspend or close an account that breaks these terms. If the test or the service ends, we will tell you in advance.',
        ],
      },
      {
        heading: 'Changes to these terms',
        paragraphs: [
          'Each version of these terms has a date. We will tell you before an important change takes effect; if you keep using FlatChat after that, the new version applies. These terms apply from {effective}.',
        ],
      },
      {
        heading: 'Law and disputes',
        paragraphs: [
          'Colombian law governs these terms. If something goes wrong, write to {contact} first: most problems are solved that way. Disputes go to the competent courts of Colombia. [TO DECIDE: the city whose courts hear disputes]',
          'About your personal data, you can complain to the Superintendencia de Industria y Comercio once you have asked us first.',
        ],
      },
    ],
  },

  privacy: {
    title: 'Privacy notice',
    summary: 'Who keeps your data on FlatChat, what is kept and why, who receives it, for how long, and your rights.',
    sections: [
      {
        heading: 'Who is responsible',
        paragraphs: [
          'FlatChat is a social world platform in a closed test. {operator} runs this server and is responsible for your data. Address: {address}. Email: {contact}. Phone: {phone}.',
          'This notice explains what happens to your data. The data processing policy, at /data-policy, sets out how to exercise your rights under Colombian law (Ley 1581 de 2012 and Decreto 1377 de 2013).',
        ],
      },
      {
        heading: 'Your account',
        paragraphs: [
          'When you sign up, we keep your email address, a hash of your password (never the password itself), your display name, your birth month and year (never the day), your country, which invitation you used (if one brought you), and when you accepted this notice and which version.',
          'As you use FlatChat, we keep whether your email is confirmed, your trust level, whether you are a tester, a count of the days on which you joined a world, your sign-in sessions (when each started, was last used and ended: never your IP address or device), your friends and friend requests, the accounts you block or mute, your favourite worlds, the avatar you wear, and the worlds you register with their approval record.',
        ],
      },
      {
        heading: 'What you upload',
        paragraphs: [
          'For each avatar, item, emote, dance or sound you upload, we keep the file you sent, the files made from it and its name; for an avatar or an item, also its fingerprint (the shape of its meshes and a short hash of each texture), which catches copies of what was taken down. A gallery entry adds its licence, its authors and how many times it was taken. Your outfits are kept as lists of your items.',
          'Deleting an upload stops its delivery and takes it out of the gallery; copies others already took stay with them. [TO DECIDE: how long the files of deleted uploads are kept]',
        ],
      },
      {
        heading: 'Reports and safety records',
        paragraphs: [
          'A report keeps what the reporter wrote and its evidence: the last 50 chat lines the reporter saw, who was near and how far, the times and, if attached, a 15-second voice clip. It also keeps who filed it (or the email given on the public form), who or what it is about, and our decision.',
          'We keep the moderation decisions about your account with their reasons, your appeals and their answers, and strikes for uploads taken down. A takedown request keeps the name, email, statement and signature of the person who asks, and our decision.',
          'In a case of child sexual abuse material or of intimate images shared without consent, we seal an encrypted copy of the evidence we hold, to give to the authorities.',
        ],
      },
      {
        heading: 'Teens and guardians',
        paragraphs: [
          'For an account aged 13 to 17, we also keep the email address of the parent or guardian the teen named, when the teen agreed to supervision, the guardian’s account, and the proof of the guardian’s authorization: when, how, which summary they read, and their express authorization for world servers abroad. We keep the guardian’s choice of who may talk to the teen.',
          'A guardian’s own account is an ordinary account, with the data listed above.',
        ],
      },
      {
        heading: 'Why we use it',
        paragraphs: [
          '• To run your account, sign you in and let you join worlds.',
          '• To apply the age rules and the protections for minors.',
          '• To deliver what you upload and wear, and to catch copies of what was taken down.',
          '• To handle reports, appeals and takedowns, and to keep FlatChat safe and lawful.',
          '• To send the only emails FlatChat sends: a link to confirm your address, and a guardian’s invitation.',
          'We process your data with the authorization you give at sign-up (for a teen, the guardian’s), or where the law allows or requires it, and for nothing else.',
        ],
      },
      {
        heading: 'What a world receives',
        paragraphs: [
          'Worlds run on their hosts’ own computers, some outside Colombia. When you join one, this server gives your app a sealed pass for that world alone, valid for one minute, holding only: your account number, display name and trust level; whether you are a tester, whether your email is confirmed, how many days old your account is, whether you are under 18 and whether the world is yours; the avatar you wear; who may talk to you; and the accounts kept apart from you by a block. For an account under 18, also its accepted friends. Never your email, birth date or country.',
          'While you are in a world, the host’s computer also receives your IP address with your connection, your position and movements, what you wear, your chat lines and your voice. The world server passes your voice on to the people near you and never keeps it; the host agreement forbids recording it.',
          'Each world keeps its own small database on its host’s computer: where you last stood, your role there, and its bans, mutes and moderation record. Its plugins can read its chat and keep notes about visitors. That database is the host’s, not ours.',
        ],
      },
      {
        heading: 'What other players see',
        paragraphs: [
          'Other players see your display name, your avatar and items, your position, and your voice and chat as each world’s rules allow. Their app downloads the converted files of what you wear. A gallery entry shows your display name as its publisher.',
          'A block keeps two accounts apart, both ways. Teens are heard, read and talked to only by their friends, unless their guardian chose otherwise.',
        ],
      },
      {
        heading: 'Your voice',
        paragraphs: [
          'FlatChat never records your voice. Your app keeps the last 15 seconds of what you hear in memory only, always overwriting it. They leave your computer only inside a report you send with its box ticked; the box starts ticked, so untick it to send a report without sound.',
          'A clip holds everyone you heard in those seconds. We use it only to decide on the report, and it is erased with the report’s evidence (or with the sealed copy of an abuse case).',
        ],
      },
      {
        heading: 'Who else receives data',
        paragraphs: [
          'A few services help run FlatChat, and each receives only what its job needs:',
          '• Cloudflare carries every connection to this server through its tunnel, and its STUN server tells your app its own public address.',
          '• A relay (TURN) server, ours or Cloudflare’s, carries a world’s traffic when no direct path works. It sees your IP address; on our own relay, its sign-in names carry your account number.',
          '• Resend sends our emails: it receives the address and the text.',
          '• kyonax.com serves the app’s downloads and updates. It sees your IP address when the app checks for an update, which you can switch off in Settings.',
          'Some of these services are outside Colombia. [TO DECIDE: name each service provider and its country] We do not sell your data, share it for advertising, or give it to anyone else, except as this notice says or the law requires.',
        ],
      },
      {
        heading: 'How long we keep it',
        paragraphs: [
          '• A report’s evidence: 183 days, or 365 days for reports of child sexual abuse material or grooming. Then its text, chat lines, clip and contact are erased; the record that a report was made (who filed it, about whom, its category, its decision and the dates) stays. [TO DECIDE: how long purged report records are kept]',
          '• The sealed evidence of an abuse case: 365 days. Then it is erased; the case record stays.',
          '• Your account and what goes with it: while your account exists. [TO DECIDE: how an account is deleted on request and what stays]',
          '• Signing in: your app stays signed in for 30 days after it last reached this server. [TO DECIDE: how long sign-in session records are kept]',
          '• Moderation decisions, appeals, strikes, takedown requests and the fingerprints of what was taken down. [TO DECIDE: how long moderation records, strikes, takedowns and fingerprints are kept]',
          '• This server’s log: one line per request (the page, the result and the time, never what you sent), and a few events with an account or world number. [TO DECIDE: how long the core logs are kept]',
          '• A guardian request that nobody answered. [TO DECIDE: how long an unanswered guardian request is kept]',
          '• When the age rule refuses a sign-up, we keep nothing the person typed: only that the invitation was refused. Their browser keeps a cookie for 30 days, so that a second try gets the same answer.',
        ],
      },
      {
        heading: 'No tracking',
        paragraphs: [
          'FlatChat has no ads, no analytics and no tracking. Its pages run no scripts and set only three cookies: one that remembers an age refusal (30 days), and the sign-in cookies of the guardian page and of the operator’s admin page (12 hours each).',
          'Your app keeps your settings, your sign-in (encrypted by your system) and downloaded files on your computer, until you delete them.',
        ],
      },
      {
        heading: 'Security',
        paragraphs: [
          'Passwords are kept as Argon2id hashes and sign-in tokens only as digests; world keys and sealed evidence are encrypted under this server’s secret. You sign in through your own browser, and the code goes only to the app on your computer. Uploads are converted in a sandbox.',
          'This server runs on the operator’s computer behind an encrypted tunnel, with no open port. [TO DECIDE: where backups are kept, and for how long]',
          'If a security problem puts your data at risk, we tell the Superintendencia de Industria y Comercio and the people affected.',
        ],
      },
      {
        heading: 'Children',
        paragraphs: [
          'Nobody under 13 can have an account, and when the age rule refuses someone we keep nothing they typed. From 13 to 17, an account can be made only while this server accepts teens (in Australia from 16, and not yet in Brazil), and it plays only once a parent or legal guardian authorizes it.',
          'Teens get stronger protections: voice and chat only with their accepted friends unless their guardian chooses otherwise, a microphone that starts muted, and no friend requests from anyone. Worlds learn only that they are under 18. See the pages for teens and for guardians.',
          'If you think an account belongs to someone under the minimum age, report it: the account is suspended until we check, and deleted if the report is right.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'Under Ley 1581 de 2012 you can know, update and correct your data; ask for proof of your authorization; ask how your data is used; revoke your authorization or ask us to delete your data, unless a legal or contractual duty requires us to keep it; consult your data free of charge; and complain to the Superintendencia de Industria y Comercio once you have asked us first.',
          'Write to {contact} from your account’s email address. We answer queries within 10 business days and claims within 15 business days, as the data processing policy explains. A teen’s parent or guardian can exercise the teen’s rights too.',
        ],
      },
      {
        heading: 'Changes to this notice',
        paragraphs: [
          'This notice has a version and a date. When it changes in a way that matters, we tell you before the change takes effect, and we ask for your authorization again before using your data for a new purpose. This version applies from {effective}.',
        ],
      },
    ],
  },

  dataPolicy: {
    title: 'Data processing policy',
    summary: 'How FlatChat processes personal data under Ley 1581 de 2012 and Decreto 1377 de 2013, and how to exercise your rights. This is a translation: the Spanish text governs.',
    sections: [
      {
        heading: 'Controller',
        paragraphs: [
          'The controller (responsable del tratamiento) of the personal data collected on FlatChat is {operator}.',
          '• Domicile and address: {address}.',
          '• Email: {contact}.',
          '• Phone: {phone}.',
          'FlatChat is a social world platform in a closed test. This policy implements Ley 1581 de 2012 and meets article 13 of Decreto 1377 de 2013 (now compiled in Decreto 1074 de 2015).',
        ],
      },
      {
        heading: 'Definitions',
        paragraphs: [
          '• Data subject (titular): the person the data is about.',
          '• Personal data: any information that identifies a person, or can identify them.',
          '• Processing: any operation on personal data, such as collecting, storing, using, sending or deleting it.',
          '• Controller: who decides on the processing. Processor (encargado): who processes data on the controller’s behalf.',
          '• Authorization: the data subject’s prior, express and informed consent to the processing.',
        ],
      },
      {
        heading: 'Processing and purposes',
        paragraphs: [
          'We collect, store, use and, when needed, send and delete personal data in these databases, for these purposes:',
          '• Accounts: email, password hash, display name, birth month and year, country, the authorization (its version, date and method), sessions, trust level and active days, friends, blocks, mutes, favourites and the avatar worn. To keep the account, sign in, join worlds and apply the age rules.',
          '• Worlds: the worlds registered, their address, capacity and approval, and the acceptance of the host agreement. To approve worlds, list them and let their visitors in.',
          '• Content: uploaded files (avatars, items, emotes, dances and sounds), the files made from them, their names, licences and fingerprints. To deliver them to the people who see the wearer, publish them in the gallery and catch copies of what was taken down.',
          '• Safety and moderation: reports with their evidence and voice clips, moderation decisions, appeals, strikes, takedown requests and abuse cases. To handle reports and appeals, protect people and comply with the law.',
          '• Minors and guardians: the guardian’s email the minor named, the guardian’s account, the proof of their authorization and their choice of who may talk to the minor. So that a minor plays only with authorization and under the protections for minors.',
          '• Public forms: what people write when they report something or ask for a takedown without an account, and the email they leave. To handle it and answer them.',
          'When someone joins a world, that world’s server, which runs on its host’s computer and may be outside Colombia, receives only the data the privacy notice lists. We do not use data for advertising, and we do not sell it.',
        ],
      },
      {
        heading: 'Data of children and adolescents',
        paragraphs: [
          'We do not accept accounts for anyone under 13. From 13 to 17, an account plays only once its parent or legal guardian authorizes it after reading a plain summary; first, the teen gives their opinion and agrees to supervision (article 12 of Decreto 1377 de 2013).',
          'We process this data respecting the best interests and prevailing rights of minors (article 7 of Ley 1581 de 2012): voice and text only with accepted friends unless the guardian decides otherwise, no friend requests from anyone, and worlds learn only that the player is under 18.',
        ],
      },
      {
        heading: 'Processors and transfers',
        paragraphs: [
          'To run FlatChat we use processors: Cloudflare (the connection to this server, and STUN), a relay (TURN) server, Resend (emails) and the downloads and updates site (kyonax.com). Some are outside Colombia. [TO DECIDE: name each service provider and its country]',
          'World servers are run by their hosts, who may be in other countries. When you sign up, you authorize them to receive the data the privacy notice lists; for a minor, the guardian authorizes it expressly.',
        ],
      },
      {
        heading: 'Rights of data subjects',
        paragraphs: [
          'Under article 8 of Ley 1581 de 2012, as a data subject you can:',
          '• know, update and correct your data, also when it is partial, inaccurate, incomplete or misleading;',
          '• ask for proof of the authorization you gave us;',
          '• be told, on request, how we have used your data;',
          '• complain to the Superintendencia de Industria y Comercio;',
          '• revoke the authorization and ask for your data to be deleted;',
          '• consult your data free of charge.',
        ],
      },
      {
        heading: 'Who handles petitions, queries and claims',
        paragraphs: [
          '{operator} personally handles petitions, queries and claims about personal data: by email to {contact}, in writing at {address}, or by phone at {phone}.',
          'The rights can be exercised by the data subject, proving their identity (for example, by writing from their account’s email address); by their successors; by their representative or attorney; and, for a minor, by whoever legally represents them.',
        ],
      },
      {
        heading: 'Queries',
        paragraphs: [
          'To know your data or how we use it, write to {contact} saying what you want to know.',
          'We answer within 10 business days of receiving the query. If we cannot, we tell you first why and when we will answer, within 5 more business days at most (article 14 of Ley 1581 de 2012). Queries are free.',
        ],
      },
      {
        heading: 'Claims',
        paragraphs: [
          'To update, correct or delete your data, revoke your authorization, or point out that we failed a duty, send a claim to {contact} with your identification, the facts, the address or email for our answer, and any documents you want to add.',
          'If something is missing, we ask for it within 5 days; if you do not send it within 2 months, we take the claim as withdrawn. If we are not the right party, we pass it on within 2 business days and tell you.',
          'Once the claim is complete, we mark your data “claim in progress” (reclamo en trámite) within 2 business days. We answer within 15 business days from the day after we received it; if we cannot, we tell you why and when, within 8 more business days at most (article 15 of Ley 1581 de 2012).',
          'Deletion and revocation do not apply when you have a legal or contractual duty to remain in the database (article 9 of Decreto 1377 de 2013). [TO DECIDE: how an account is deleted on request and what stays]',
          'Before complaining to the Superintendencia de Industria y Comercio, you must first complete the query or the claim with us (article 16 of Ley 1581 de 2012).',
        ],
      },
      {
        heading: 'Security',
        paragraphs: [
          'We keep passwords as Argon2id hashes and tokens only as digests, encrypt sealed evidence and world keys, convert uploads in a sandbox, and run this server behind an encrypted tunnel. We report to the Superintendencia de Industria y Comercio any security breach that puts the data at risk. [TO DECIDE: where backups are kept, and for how long]',
        ],
      },
      {
        heading: 'Changes to this policy',
        paragraphs: [
          'We will tell you about any substantial change to this policy before applying it, and ask for a new authorization if the purpose of the processing changes.',
        ],
      },
      {
        heading: 'Validity',
        paragraphs: [
          'This policy applies from {effective}.',
          'FlatChat’s databases remain in force while FlatChat operates. Within that time, we keep each piece of data only as long as its purpose needs: report evidence for 183 days (365 days for child sexual abuse material and grooming), the sealed evidence of abuse cases for 365 days, and the other periods the privacy notice gives.',
        ],
      },
    ],
  },

  teens: {
    title: 'FlatChat for teens',
    summary: 'What FlatChat is, and how it keeps players aged 13 to 17 safe.',
    sections: [
      {
        heading: 'What FlatChat is',
        paragraphs: [
          'FlatChat is a place where people meet in 3D worlds and talk by voice and text. People host the worlds on their own computers. It is free and has no ads.',
          'You can join from 13 (16 in Australia; not yet in Brazil). First, your parent or guardian has to say yes. Until then, you cannot play.',
        ],
      },
      {
        heading: 'What is different for you',
        paragraphs: [
          '• Only your friends can talk or write to you, and only they hear you, unless your parent or guardian changes that.',
          '• Nobody can send you a friend request. You can send one to someone you know.',
          '• Your microphone starts muted when you join a world.',
          '• Others in a world can still see your avatar and your display name.',
          '• Worlds only learn that you are under 18: never your birth date or your email.',
          '• Your parent or guardian sees your friends, can remove one, and chooses who can talk to you. They cannot read your chats or hear your voice, and you always see that supervision is on.',
        ],
      },
      {
        heading: 'If something feels wrong',
        paragraphs: [
          'Block someone and you stop seeing and hearing each other in every world. Mute someone and you stop hearing them. Shift+Esc turns every other avatar into a plain figure and stops every overlay at once.',
          'To report, open the People list (Tab) and choose Report. The last 15 seconds of what you heard can go with it, and you get a reference.',
          'Nobody may ask you for sexual pictures, to meet in person or to keep secrets from your family. If someone does, block them, report them and tell an adult you trust. If you are in danger, call your local emergency number. In Colombia: 123, or the ICBF’s line 141.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'You can ask what we keep about you, ask us to correct it or delete it, and have your say about it. Write to {contact}; your parent or guardian can help. The community rules, the terms of use and the privacy notice tell you more.',
        ],
      },
    ],
  },

  guardians: {
    title: 'FlatChat for parents and guardians',
    summary: 'What you authorize when your teen joins FlatChat, what you can see and do, and how to stop it.',
    sections: [
      {
        heading: 'What you authorize',
        paragraphs: [
          'FlatChat is a place where people meet in 3D worlds and talk by voice and text. Players aged 13 to 17 play only once a parent or legal guardian authorizes them, with an adult account that uses the email address the teen gave us.',
          'By authorizing, you agree that we process your teen’s data as the privacy notice describes, and that the world servers they join, some outside Colombia, receive the facts it lists. Your teen agreed to your supervision first. We keep the proof: when, how, and which summary you read.',
        ],
      },
      {
        heading: 'How your teen is protected',
        paragraphs: [
          '• Voice and text only with the friends they accepted; their microphone starts muted.',
          '• Nobody can send them a friend request; they can send one.',
          '• Worlds learn that they are under 18, never their email or birth date. Others in a world can still see their avatar and display name.',
          '• They can block, mute and report anyone, and a block keeps that person apart from them in every world.',
        ],
      },
      {
        heading: 'What you can see and do',
        paragraphs: [
          'Sign in at /guardian with your own account. There you see your teen’s friends and can remove any of them, and you choose who may talk to your teen by voice and text: only accepted friends (the default), everyone in the worlds they join, or nobody. [TO DECIDE: the client still limits teens to friends when a guardian picks everyone]',
          'You do not see their chats or hear their voice. FlatChat keeps neither, except what a player attaches to a report.',
        ],
      },
      {
        heading: 'Withdrawing, and turning 18',
        paragraphs: [
          'You can withdraw your authorization at any time by writing to {contact}; your teen’s account then stops. [TO DECIDE: how a guardian withdrawal is carried out]',
          'At 18, the protections for minors end. [TO DECIDE: whether the guardian link ends at 18]',
          'Questions or a concern? Write to {contact}, or report it at /report. In an emergency, call your local emergency number first.',
        ],
      },
    ],
  },

  lawEnforcement: {
    title: 'Law enforcement policy',
    summary: 'How authorities can ask this FlatChat server for data, and how we handle emergencies, preservation and child safety.',
    sections: [
      {
        heading: 'Who we are and how to reach us',
        paragraphs: [
          'FlatChat is a social world platform in a closed test, run from Colombia by {operator}, {address}. Send requests to {contact} with “Law enforcement request” in the subject, or in writing to that address.',
          'Name exactly the accounts or worlds a request is about (an account number, a display name, an email address, a world ID or a report reference) and what is needed.',
        ],
      },
      {
        heading: 'Valid legal process',
        paragraphs: [
          'We disclose personal data only on a valid request: a court order, or a written request from a Colombian public authority acting within its legal functions (Ley 1581 de 2012, articles 10 and 13).',
          'Foreign authorities must use the channels Colombian law recognizes, such as mutual legal assistance through the Colombian authorities. We do not answer informal requests.',
          'We check each request, ask for clarification when it is too broad, and disclose only what it covers.',
        ],
      },
      {
        heading: 'Emergencies',
        paragraphs: [
          'When we believe in good faith that someone, a child above all, faces an imminent risk of death or serious harm, we may disclose the least data needed to an authority that can help, without waiting for legal process. We ask for the formal request afterwards.',
        ],
      },
      {
        heading: 'Preservation',
        paragraphs: [
          'On an authority’s request, we preserve what we hold about the named accounts or worlds while the legal process is obtained, for up to 365 days: the time we keep the sealed evidence of an abuse case. [TO DECIDE: how a preservation request is applied outside an abuse case]',
        ],
      },
      {
        heading: 'What data exists',
        paragraphs: [
          'The privacy notice lists what we keep and for how long. In short: account data (email, display name, birth month and year, country), sign-in times, friends, blocks, uploads, worlds, reports with their evidence and voice clips, and moderation records.',
          'This server stores no IP addresses, no voice conversations and no chat logs. Voice and chat reach us only inside the reports that players send, and report evidence is erased after 183 days (365 days for child sexual abuse material and grooming).',
          'Worlds run on their hosts’ own computers, which keep their own records and see their visitors’ IP addresses. We can say which account hosts a world, and take the world down.',
        ],
      },
      {
        heading: 'Child safety',
        paragraphs: [
          'When we find child sexual abuse material, we remove it at once, ban the account or take the world down, seal the evidence for 365 days, and report it to Te Protejo and to the CAI Virtual of Colombia’s Policía Nacional, and to the UK’s National Crime Agency (CEOP) when the case is linked to the United Kingdom. Once the operator is registered as an electronic service provider, we also report it to NCMEC’s CyberTipline.',
          'We remove intimate images shared without consent within 48 hours of the report, and record how long it took.',
        ],
      },
      {
        heading: 'Records and notice',
        paragraphs: [
          'We keep a record of every request: who asked, when, under what authority, what was asked and what we disclosed. [TO DECIDE: where the law-enforcement request log is kept]',
          'We tell the people concerned before we disclose their data, unless the law or a court forbids it, or telling them would put a child or anyone else at risk or harm an investigation. In abuse cases, the account is told only that it seriously broke the community rules.',
        ],
      },
    ],
  },
};

const es: Record<DocumentId, Doc> = {
  rules: {
    title: 'Reglas de la comunidad',
    summary: 'Qué no se permite en FlatChat, qué pasa cuando alguien rompe una regla y cómo reportarlo.',
    sections: [
      {
        heading: 'En pocas palabras',
        paragraphs: [
          'Estas reglas valen en todo FlatChat: en cada mundo, en la voz y el chat, en los nombres visibles y en cada avatar, prenda, gesto, sonido, superposición y mundo.',
          'Trata a las personas con respeto. Mantén todo libre de contenido sexual. No rompas la ley. Si algo sale mal, bloquea, silencia o reporta.',
          'Romper una regla puede costarte un mundo, una subida o tu cuenta. Los términos de uso agregan reglas para lo que subes, y el acuerdo de anfitriones para alojar un mundo.',
        ],
      },
      {
        heading: 'Nada de contenido sexual ni desnudos',
        paragraphs: [
          'En FlatChat no hay contenido sexual ni desnudos en ninguna parte: ni en avatares, prendas, gestos, sonidos, superposiciones o mundos, ni en el chat, la voz o los nombres. Esto vale aunque los campos de licencia de una subida lo permitan.',
          'El material de abuso sexual infantil es un delito. Lo retiramos de inmediato, bloqueamos la cuenta o sacamos el mundo, guardamos la evidencia y lo denunciamos ante las autoridades.',
          'Ningún adulto puede buscar sexualmente a un menor (grooming): nada de conversaciones sexuales, ni pedir fotos, ni pedir encuentros, ni pedir que guarde secretos.',
          'Nunca compartas imágenes íntimas de nadie sin su consentimiento.',
        ],
      },
      {
        heading: 'Respeta a las personas',
        paragraphs: [
          '• Nada de acoso ni matoneo: ni insultos, ni seguir a alguien que te pidió parar, ni azuzar a otros contra alguien.',
          '• Nada de odio: ningún ataque a personas por su raza, etnia, nacionalidad, religión, sexo, género, orientación sexual, discapacidad o enfermedad.',
          '• Nada de amenazas ni violencia: ni amenazar con hacer daño, ni animar a nadie a hacerse daño, ni celebrar ataques.',
          '• Nada de suplantación: no te hagas pasar por otra persona, un anfitrión, un moderador, el operador o una figura pública.',
          '• Nada de compartir datos privados: nunca compartas el nombre real, la dirección, el teléfono, el colegio, las fotos, la dirección IP o los datos de la cuenta de alguien sin su consentimiento.',
        ],
      },
      {
        heading: 'Juega limpio y dentro de la ley',
        paragraphs: [
          '• Nada ilegal: nada que rompa la ley colombiana o la del lugar donde estás, como vender drogas o armas, estafar o copiar la obra de otros sin permiso.',
          '• Nada de trampas: ninguna aplicación ni servidor de mundo modificado para saltarse estas reglas o las protecciones para menores, ningún ataque a los servidores, ni aprovechar fallas: si encuentras una, repórtala.',
          '• Nada de spam ni estafas: no inundes el chat, no hagas publicidad, no compartas enlaces a estafas y nunca le pidas a nadie su contraseña.',
          '• No esquives una decisión: no uses otra cuenta para escapar de una suspensión o un bloqueo, y da tu verdadero mes y año de nacimiento y tu país.',
        ],
      },
      {
        heading: 'Qué pasa en un mundo',
        paragraphs: [
          'Cada mundo tiene un dueño y puede tener moderadores. Pueden sacarte del mundo, silenciarte o bloquearte en él por una hora, un día, una semana o hasta que levanten el bloqueo. Siempre dan un motivo, y tú lo ves.',
          'El bloqueo en un mundo queda en los registros de ese mundo, así que salir y volver no lo deshace. Puedes apelar ante el dueño del mundo desde la aplicación: lee tu apelación y decide.',
          'Un mundo puede tener reglas propias además de estas, nunca más flojas.',
        ],
      },
      {
        heading: 'Qué pasa en FlatChat',
        paragraphs: [
          'El operador actúa en toda la plataforma. Según lo que haya pasado, podemos:',
          '• retirar un avatar, una prenda o una superposición de todas partes (cada retiro es una falta para la cuenta que lo subió);',
          '• sacar un mundo de FlatChat, para que nadie pueda entrar;',
          '• suspender una cuenta hasta que levantemos la suspensión, o bloquearla. Una cuenta suspendida o bloqueada no puede iniciar sesión ni entrar a un mundo.',
          'Ves la decisión y su motivo cuando inicias sesión. [TO DECIDE: whether formal warnings come before a suspension]',
          'El material de abuso sexual infantil y las imágenes íntimas compartidas sin consentimiento significan un bloqueo inmediato. Una cuenta reportada por estar por debajo de la edad mínima se suspende hasta que revisemos su edad, y se elimina si el reporte es cierto.',
        ],
      },
      {
        heading: 'Apelaciones',
        paragraphs: [
          'Si crees que una suspensión o un bloqueo es un error, inicia sesión: la página muestra la decisión y un formulario para apelarla. Quien opera FlatChat lee cada apelación, y ves la respuesta cuando vuelves a iniciar sesión. Si revertimos la decisión, tu cuenta vuelve a funcionar.',
          'Apela el bloqueo de un mundo ante el dueño de ese mundo, desde la aplicación.',
          '[TO DECIDE: whether a removed avatar or item can be appealed]',
        ],
      },
      {
        heading: 'Cómo reportar',
        paragraphs: [
          'En un mundo, abre la lista de gente (Tab), elige a la persona y luego Reportar, o usa Reportar este mundo. Di de qué se trata y qué pasó.',
          'Un reporte lleva las últimas 50 líneas de chat que viste, quién estaba cerca y las horas. Mientras su casilla siga marcada, también lleva los últimos 15 segundos de lo que oíste; desmárcala para enviar el reporte sin sonido.',
          'Recibes una referencia como R-XXXX-XXXX, y la respuesta aparece en tu pantalla de inicio. Leemos cada reporte: el abuso de menores, el grooming y las amenazas en horas, lo demás en días.',
          'Sin cuenta, usa el formulario de reportes en /report. ¿Copian tu obra en FlatChat? Pide el retiro en /takedown. Si alguien está en peligro ahora mismo, llama primero al número de emergencias de tu país.',
        ],
      },
      {
        heading: 'Protégete',
        paragraphs: [
          'En la lista de gente puedes bajarle el volumen a alguien, silenciarlo, ocultar su avatar, detener sus superposiciones o bloquearlo. Los silencios y los bloqueos siguen a tu cuenta a todos los mundos.',
          'Un bloqueo funciona en ambos sentidos: dejan de verse y de oírse, y cualquier amistad entre ustedes termina.',
          'Las orejeras te dejan oír solo a quien está cerca. Mayús+Esc es la tecla de modo seguro: todos los demás avatares se ven como una figura simple, y todas las superposiciones y efectos se detienen a la vez.',
        ],
      },
    ],
  },

  terms: {
    title: 'Términos de uso',
    summary: 'El acuerdo entre tú y quien opera este servidor de FlatChat, durante la prueba cerrada.',
    sections: [
      {
        heading: 'Quiénes somos',
        paragraphs: [
          'FlatChat es una plataforma de mundos sociales en prueba cerrada. {operator} («nosotros») opera este servidor. Dirección: {address}. Correo: {contact}. Teléfono: {phone}.',
          'Al crear una cuenta o usar FlatChat, aceptas estos términos, las reglas de la comunidad y el aviso de privacidad. [TO DECIDE: whether sign-up asks people to accept these terms]',
          'El código de FlatChat es abierto, bajo las licencias que indica su repositorio. Estos términos cubren el servicio que presta este servidor, no el código.',
        ],
      },
      {
        heading: 'Una prueba cerrada',
        paragraphs: [
          'FlatChat no está terminado. Durante la prueba se entra por invitación, las funciones cambian, las cosas fallan y los mundos o los datos pueden reiniciarse o perderse. [TO DECIDE: whether test accounts and data are wiped when the test ends]',
          'FlatChat es gratis: sin pagos, sin publicidad y sin rastreo.',
        ],
      },
      {
        heading: 'Tu cuenta',
        paragraphs: [
          'Debes tener al menos 13 años. Entre 13 y 17 años, tu madre, padre o tutor legal debe autorizar tu cuenta antes de que puedas jugar, y este servidor debe estar aceptando adolescentes: en partes de la prueba solo acepta adultos. En Australia la edad mínima es 16 años, y los adolescentes de Brasil todavía no pueden entrar.',
          'Da tu verdadero mes y año de nacimiento y tu país. Una cuenta que resulte estar por debajo de la edad mínima se elimina.',
          'Guarda tu contraseña solo para ti: respondes por lo que se haga con tu cuenta. Tu nombre visible sigue las reglas de la comunidad.',
        ],
      },
      {
        heading: 'Lo que subes',
        paragraphs: [
          'Cuando tu cuenta llega al nivel de confianza 1 (unos días de antigüedad y el correo confirmado), puedes subir avatares, prendas, gestos y bailes con sus sonidos.',
          'Sube solo lo que hiciste o tienes derecho a compartir, y solo lo que cumple las reglas de la comunidad: nada de contenido sexual ni desnudos, digan lo que digan los campos de licencia del archivo.',
          'Conservas tus derechos. Le das al operador un permiso gratuito y mundial para guardar, convertir, copiar y entregar lo que subes, y para mostrarlo a quienes te ven, mientras esté en FlatChat y mientras nuestros registros de seguridad lo necesiten.',
          'Cuando llevas algo puesto, la aplicación de cada persona que te ve descarga sus archivos convertidos. El archivo que subiste nunca se entrega a nadie.',
          'Las copias de obras ajenas se rechazan o se retiran. Guardamos la huella de lo que retiramos, para detectar sus copias. Cada retiro es una falta para la cuenta que lo subió, y las faltas pueden llevar a un bloqueo.',
        ],
      },
      {
        heading: 'La galería gratuita',
        paragraphs: [
          'Desde el nivel de confianza 2, puedes publicar tus propios avatares y prendas en la galería gratuita. Confirmas que son tuyos para compartir y que cumplen las reglas de contenido, e indicas su licencia: cada uno de los términos de VRM 1.0.',
          'La galería acepta solo lo que todos pueden usar. La licencia de un avatar puede ser más estricta que los términos de su propio archivo, nunca más amplia.',
          'Quien toma una entrada recibe su propia copia. Si la retiras, sale de la galería, pero las copias ya tomadas se quedan. Los demás pueden copiarla, cambiarla o usarla con fines comerciales solo hasta donde tu licencia lo permita.',
        ],
      },
      {
        heading: 'Alojar un mundo',
        paragraphs: [
          'Los mundos corren en los propios computadores de sus anfitriones. Para que un mundo sea aprobado, aceptas el acuerdo de anfitriones (en /host-agreement): nada de grabaciones, reportes reenviados, retiros cumplidos y protecciones para menores intactas.',
          'Respondes por tu mundo: sus archivos, sus plugins, los constructores y moderadores que elijas y el trato que reciben sus visitantes. Tu computador recibe las direcciones IP, la voz y el chat de tus visitantes: nunca los grabes, ni los compartas, ni los uses para nada distinto de correr el mundo.',
          'Si quien aloja un mundo rompe el acuerdo, revocamos la aprobación del mundo y nadie puede entrar.',
        ],
      },
      {
        heading: 'Moderación',
        paragraphs: [
          'Podemos retirar contenido, sacar mundos y suspender o bloquear cuentas que rompan estos términos o las reglas de la comunidad, como lo describen las reglas. Puedes apelar una suspensión o un bloqueo.',
          'Denunciamos el material de abuso sexual infantil ante las autoridades y respondemos sus solicitudes válidas, como lo describe la política para autoridades.',
        ],
      },
      {
        heading: 'Sin garantías durante la prueba',
        paragraphs: [
          'FlatChat se ofrece tal como está, mientras se prueba. No prometemos que funcione siempre, que no se pierdan datos ni que sirva para un fin determinado.',
          'En la medida en que la ley lo permite, no respondemos por pérdidas causadas por caídas del servicio, datos perdidos, otras personas o los mundos que corren los anfitriones. Nada de esto te quita los derechos que la ley te da y que no se pueden renunciar.',
        ],
      },
      {
        heading: 'Cerrar tu cuenta',
        paragraphs: [
          'Puedes dejar de usar FlatChat cuando quieras y pedirnos eliminar tu cuenta escribiendo a {contact}. [TO DECIDE: how an account is deleted on request and what stays]',
          'Podemos suspender o cerrar una cuenta que rompa estos términos. Si la prueba o el servicio terminan, te avisaremos con anticipación.',
        ],
      },
      {
        heading: 'Cambios a estos términos',
        paragraphs: [
          'Cada versión de estos términos tiene una fecha. Te avisaremos antes de que un cambio importante empiece a regir; si sigues usando FlatChat después, aplica la nueva versión. Estos términos rigen desde el {effective}.',
        ],
      },
      {
        heading: 'Ley y conflictos',
        paragraphs: [
          'Estos términos se rigen por la ley colombiana. Si algo sale mal, escribe primero a {contact}: así se resuelven casi todos los problemas. Los conflictos van a los jueces competentes de Colombia. [TO DECIDE: the city whose courts hear disputes]',
          'Sobre tus datos personales, puedes presentar una queja ante la Superintendencia de Industria y Comercio después de habernos consultado primero.',
        ],
      },
    ],
  },

  privacy: {
    title: 'Aviso de privacidad',
    summary: 'Quién guarda tus datos en FlatChat, qué se guarda y para qué, quién los recibe, por cuánto tiempo y cuáles son tus derechos.',
    sections: [
      {
        heading: 'Quién es responsable',
        paragraphs: [
          'FlatChat es una plataforma de mundos sociales en prueba cerrada. {operator} opera este servidor y es responsable del tratamiento de tus datos. Dirección: {address}. Correo: {contact}. Teléfono: {phone}.',
          'Este aviso explica qué pasa con tus datos. La política de tratamiento de la información, en /data-policy, explica cómo ejercer tus derechos según la ley colombiana (Ley 1581 de 2012 y Decreto 1377 de 2013).',
        ],
      },
      {
        heading: 'Tu cuenta',
        paragraphs: [
          'Cuando te registras, guardamos tu correo, un hash de tu contraseña (nunca la contraseña), tu nombre visible, tu mes y año de nacimiento (nunca el día), tu país, la invitación que usaste (si llegaste con una), y cuándo aceptaste este aviso y qué versión.',
          'Mientras usas FlatChat, guardamos si tu correo está confirmado, tu nivel de confianza, si eres parte del grupo de prueba, en cuántos días distintos entraste a un mundo, tus sesiones (cuándo empezó cada una, cuándo se usó por última vez y cuándo terminó; nunca tu dirección IP ni tu dispositivo), tus amistades y solicitudes de amistad, las cuentas que bloqueas o silencias, tus mundos favoritos, el avatar que usas y los mundos que registras con su registro de aprobación.',
        ],
      },
      {
        heading: 'Lo que subes',
        paragraphs: [
          'De cada avatar, prenda, gesto, baile o sonido que subes, guardamos el archivo que enviaste, los archivos que salen de él y su nombre; de un avatar o una prenda, también su huella (la forma de sus mallas y un hash corto de cada textura), que detecta las copias de lo retirado. Una entrada de la galería agrega su licencia, sus autores y cuántas veces se tomó. Tus atuendos se guardan como listas de tus prendas.',
          'Eliminar una subida detiene su entrega y la saca de la galería; las copias que otras personas ya tomaron se quedan con ellas. [TO DECIDE: how long the files of deleted uploads are kept]',
        ],
      },
      {
        heading: 'Reportes y registros de seguridad',
        paragraphs: [
          'Un reporte guarda lo que escribió quien reporta y su evidencia: las últimas 50 líneas de chat que vio, quién estaba cerca y a qué distancia, las horas y, si lo adjuntó, un clip de voz de 15 segundos. También guarda quién lo hizo (o el correo que dejó en el formulario público), sobre quién o qué trata y nuestra decisión.',
          'Guardamos las decisiones de moderación sobre tu cuenta con sus motivos, tus apelaciones y sus respuestas, y las faltas por subidas retiradas. Una petición de retiro guarda el nombre, el correo, la declaración y la firma de quien la hace, y nuestra decisión.',
          'En un caso de material de abuso sexual infantil o de imágenes íntimas compartidas sin consentimiento, sellamos una copia cifrada de la evidencia que tenemos, para entregarla a las autoridades.',
        ],
      },
      {
        heading: 'Adolescentes y tutores',
        paragraphs: [
          'Para una cuenta de 13 a 17 años guardamos además el correo de la madre, el padre o el tutor que nombró el adolescente, cuándo aceptó la supervisión, la cuenta del tutor y la prueba de su autorización: cuándo, cómo, qué resumen leyó y su autorización expresa para los servidores de mundos en el exterior. Guardamos la elección del tutor sobre quién puede hablarle al adolescente.',
          'La cuenta propia de un tutor es una cuenta normal, con los datos de arriba.',
        ],
      },
      {
        heading: 'Para qué los usamos',
        paragraphs: [
          '• Para mantener tu cuenta, iniciar tu sesión y dejarte entrar a mundos.',
          '• Para aplicar las reglas de edad y las protecciones para menores.',
          '• Para entregar lo que subes y llevas puesto, y detectar copias de lo retirado.',
          '• Para atender reportes, apelaciones y retiros, y mantener FlatChat seguro y dentro de la ley.',
          '• Para enviar los únicos correos que envía FlatChat: un enlace para confirmar tu dirección y la invitación a un tutor.',
          'Tratamos tus datos con la autorización que das al registrarte (para un adolescente, la de su tutor), o cuando la ley lo permite o lo exige, y para nada más.',
        ],
      },
      {
        heading: 'Qué recibe un mundo',
        paragraphs: [
          'Los mundos corren en los propios computadores de sus anfitriones, algunos fuera de Colombia. Cuando entras a uno, este servidor le da a tu aplicación un pase sellado solo para ese mundo, válido por un minuto, que lleva únicamente: tu número de cuenta, tu nombre visible y tu nivel de confianza; si eres parte del grupo de prueba, si tu correo está confirmado, cuántos días tiene tu cuenta, si eres menor de 18 años y si el mundo es tuyo; el avatar que usas; quién puede hablarte; y las cuentas que un bloqueo mantiene separadas de la tuya. Para una cuenta de menor de 18 años, también sus amistades aceptadas. Nunca tu correo, tu fecha de nacimiento ni tu país.',
          'Mientras estás en un mundo, el computador de su anfitrión también recibe tu dirección IP con tu conexión, tu posición y tus movimientos, lo que llevas puesto, tus líneas de chat y tu voz. El servidor del mundo pasa tu voz a quienes están cerca y nunca la guarda; el acuerdo de anfitriones prohíbe grabarla.',
          'Cada mundo guarda su propia pequeña base de datos en el computador de su anfitrión: dónde estuviste por última vez, tu rol allí, y sus bloqueos, silencios y registro de moderación. Sus plugins pueden leer su chat y guardar notas sobre quienes lo visitan. Esa base de datos es del anfitrión, no nuestra.',
        ],
      },
      {
        heading: 'Qué ven las demás personas',
        paragraphs: [
          'Las demás personas ven tu nombre visible, tu avatar y tus prendas, tu posición, y tu voz y tu chat según las reglas de cada mundo. Su aplicación descarga los archivos convertidos de lo que llevas puesto. Una entrada de la galería muestra tu nombre visible como quien la publicó.',
          'Un bloqueo mantiene separadas a dos cuentas, en ambos sentidos. A los adolescentes solo los oyen, los leen y les hablan sus amistades, salvo que su tutor haya elegido otra cosa.',
        ],
      },
      {
        heading: 'Tu voz',
        paragraphs: [
          'FlatChat nunca graba tu voz. Tu aplicación guarda solo en memoria los últimos 15 segundos de lo que oyes, y los reemplaza todo el tiempo. Salen de tu computador solo dentro de un reporte que envías con su casilla marcada; la casilla empieza marcada, así que desmárcala para enviar un reporte sin sonido.',
          'Un clip contiene a todas las personas que oíste en esos segundos. Lo usamos solo para decidir sobre el reporte, y se borra con la evidencia del reporte (o con la copia sellada de un caso de abuso).',
        ],
      },
      {
        heading: 'Quién más recibe datos',
        paragraphs: [
          'Algunos servicios ayudan a operar FlatChat, y cada uno recibe solo lo que su tarea necesita:',
          '• Cloudflare lleva cada conexión a este servidor por su túnel, y su servidor STUN le dice a tu aplicación su propia dirección pública.',
          '• Un servidor de retransmisión (TURN), nuestro o de Cloudflare, lleva el tráfico de un mundo cuando no hay un camino directo. Ve tu dirección IP; en el nuestro, sus nombres de acceso llevan tu número de cuenta.',
          '• Resend envía nuestros correos: recibe la dirección y el texto.',
          '• kyonax.com ofrece las descargas y las actualizaciones de la aplicación. Ve tu dirección IP cuando la aplicación busca una actualización, algo que puedes apagar en Configuración.',
          'Algunos de estos servicios están fuera de Colombia. [TO DECIDE: name each service provider and its country] No vendemos tus datos, no los compartimos para publicidad y no se los damos a nadie más, salvo como dice este aviso o lo exige la ley.',
        ],
      },
      {
        heading: 'Por cuánto tiempo los guardamos',
        paragraphs: [
          '• La evidencia de un reporte: 183 días, o 365 días en los reportes de material de abuso sexual infantil o de grooming. Después se borran su texto, sus líneas de chat, su clip y su contacto; queda el registro de que hubo un reporte (quién lo hizo, sobre quién, su categoría, su decisión y las fechas). [TO DECIDE: how long purged report records are kept]',
          '• La evidencia sellada de un caso de abuso: 365 días. Después se borra; queda el registro del caso.',
          '• Tu cuenta y lo que va con ella: mientras tu cuenta exista. [TO DECIDE: how an account is deleted on request and what stays]',
          '• La sesión: tu aplicación sigue con la sesión iniciada hasta 30 días después de su última conexión con este servidor. [TO DECIDE: how long sign-in session records are kept]',
          '• Las decisiones de moderación, las apelaciones, las faltas, las peticiones de retiro y las huellas de lo retirado. [TO DECIDE: how long moderation records, strikes, takedowns and fingerprints are kept]',
          '• El registro de este servidor: una línea por solicitud (la página, el resultado y la hora; nunca lo que enviaste), y algunos eventos con un número de cuenta o de mundo. [TO DECIDE: how long the core logs are kept]',
          '• Una solicitud a un tutor que nadie respondió. [TO DECIDE: how long an unanswered guardian request is kept]',
          '• Cuando la regla de edad rechaza un registro, no guardamos nada de lo que escribió la persona: solo que la invitación fue rechazada. Su navegador guarda una cookie por 30 días, para que un segundo intento reciba la misma respuesta.',
        ],
      },
      {
        heading: 'Sin rastreo',
        paragraphs: [
          'FlatChat no tiene publicidad, ni analítica, ni rastreo. Sus páginas no ejecutan scripts y ponen solo tres cookies: una que recuerda un rechazo por edad (30 días), y las de inicio de sesión de la página de tutores y de la página de administración del operador (12 horas cada una).',
          'Tu aplicación guarda en tu computador tu configuración, tu sesión (cifrada por tu sistema) y los archivos descargados, hasta que los borres.',
        ],
      },
      {
        heading: 'Seguridad',
        paragraphs: [
          'Las contraseñas se guardan como hashes Argon2id y los tokens de sesión solo como resúmenes; las llaves de los mundos y la evidencia sellada se cifran con el secreto de este servidor. Inicias sesión en tu propio navegador, y el código va solo a la aplicación de tu computador. Lo que subes se convierte en un entorno aislado.',
          'Este servidor corre en el computador del operador detrás de un túnel cifrado, sin puertos abiertos. [TO DECIDE: where backups are kept, and for how long]',
          'Si un problema de seguridad pone en riesgo tus datos, se lo informamos a la Superintendencia de Industria y Comercio y a las personas afectadas.',
        ],
      },
      {
        heading: 'Niñas, niños y adolescentes',
        paragraphs: [
          'Nadie menor de 13 años puede tener una cuenta, y cuando la regla de edad rechaza a alguien no guardamos nada de lo que escribió. De 13 a 17 años, una cuenta solo se puede crear mientras este servidor acepte adolescentes (en Australia desde los 16 años, y todavía no en Brasil), y juega solo cuando su madre, padre o tutor legal la autoriza.',
          'Los adolescentes tienen protecciones más fuertes: voz y chat solo con sus amistades aceptadas, salvo que su tutor elija otra cosa; un micrófono que empieza silenciado; y ninguna solicitud de amistad de nadie. Los mundos solo saben que son menores de 18 años. Mira las páginas para adolescentes y para tutores.',
          'Si crees que una cuenta es de alguien por debajo de la edad mínima, repórtala: la cuenta se suspende hasta que revisemos, y se elimina si el reporte es cierto.',
        ],
      },
      {
        heading: 'Tus derechos',
        paragraphs: [
          'Según la Ley 1581 de 2012 puedes conocer, actualizar y rectificar tus datos; pedir prueba de tu autorización; preguntar cómo se usan tus datos; revocar tu autorización o pedir que suprimamos tus datos, salvo que un deber legal o contractual nos obligue a conservarlos; consultar tus datos gratis; y presentar quejas ante la Superintendencia de Industria y Comercio después de habernos consultado primero.',
          'Escribe a {contact} desde el correo de tu cuenta. Respondemos las consultas en máximo 10 días hábiles y los reclamos en máximo 15 días hábiles, como explica la política de tratamiento de la información. La madre, el padre o el tutor de un adolescente también puede ejercer sus derechos.',
        ],
      },
      {
        heading: 'Cambios a este aviso',
        paragraphs: [
          'Este aviso tiene una versión y una fecha. Cuando cambie en algo importante, te avisaremos antes de que el cambio rija, y te pediremos de nuevo tu autorización antes de usar tus datos para una finalidad nueva. Esta versión rige desde el {effective}.',
        ],
      },
    ],
  },

  dataPolicy: {
    title: 'Política de Tratamiento de la Información',
    summary: 'Cómo trata FlatChat los datos personales según la Ley 1581 de 2012 y el Decreto 1377 de 2013, y cómo ejercer tus derechos.',
    sections: [
      {
        heading: 'Responsable del tratamiento',
        paragraphs: [
          'El responsable del tratamiento de los datos personales que se recogen en FlatChat es {operator}.',
          '• Domicilio y dirección: {address}.',
          '• Correo electrónico: {contact}.',
          '• Teléfono: {phone}.',
          'FlatChat es una plataforma de mundos sociales en prueba cerrada. Esta política desarrolla la Ley 1581 de 2012 y cumple el artículo 13 del Decreto 1377 de 2013 (hoy compilado en el Decreto 1074 de 2015).',
        ],
      },
      {
        heading: 'Definiciones',
        paragraphs: [
          '• Titular: la persona a quien se refieren los datos.',
          '• Dato personal: cualquier información que identifica o puede identificar a una persona.',
          '• Tratamiento: cualquier operación con datos personales, como recogerlos, guardarlos, usarlos, enviarlos o suprimirlos.',
          '• Responsable: quien decide sobre el tratamiento. Encargado: quien trata datos por cuenta del responsable.',
          '• Autorización: el consentimiento previo, expreso e informado del titular para el tratamiento.',
        ],
      },
      {
        heading: 'Tratamiento y finalidades',
        paragraphs: [
          'Recogemos, guardamos, usamos y, cuando hace falta, enviamos y suprimimos datos personales en estas bases de datos, con estas finalidades:',
          '• Cuentas: correo, hash de la contraseña, nombre visible, mes y año de nacimiento, país, la autorización (su versión, fecha y forma), sesiones, nivel de confianza y días de actividad, amistades, bloqueos, silencios, favoritos y el avatar que se usa. Para mantener la cuenta, iniciar sesión, entrar a mundos y aplicar las reglas de edad.',
          '• Mundos: los mundos que se registran, su dirección, su capacidad y su aprobación, y la aceptación del acuerdo de anfitriones. Para aprobar mundos, listarlos y dejar entrar a sus visitantes.',
          '• Contenido: los archivos que se suben (avatares, prendas, gestos, bailes y sonidos), los que salen de ellos, sus nombres, licencias y huellas. Para entregarlos a quienes ven a la persona que los lleva, publicarlos en la galería y detectar copias de lo retirado.',
          '• Seguridad y moderación: reportes con su evidencia y clips de voz, decisiones de moderación, apelaciones, faltas, peticiones de retiro y casos de abuso. Para atender reportes y apelaciones, proteger a las personas y cumplir la ley.',
          '• Menores y tutores: el correo del tutor que nombró el menor, la cuenta del tutor, la prueba de su autorización y su elección de quién puede hablarle al menor. Para que un menor juegue solo con autorización y con las protecciones para menores.',
          '• Formularios públicos: lo que escribe quien reporta algo o pide un retiro sin tener cuenta, y el correo que deja. Para atenderlo y responderle.',
          'Cuando una persona entra a un mundo, el servidor de ese mundo, que corre en el computador de su anfitrión y puede estar fuera de Colombia, recibe solo los datos que lista el aviso de privacidad. No usamos los datos para publicidad ni los vendemos.',
        ],
      },
      {
        heading: 'Datos de niñas, niños y adolescentes',
        paragraphs: [
          'No aceptamos cuentas de menores de 13 años. Entre 13 y 17 años, una cuenta juega solo cuando su madre, padre o tutor legal la autoriza después de leer un resumen claro; antes, el adolescente da su opinión y acepta la supervisión (artículo 12 del Decreto 1377 de 2013).',
          'Tratamos estos datos respetando el interés superior y los derechos prevalentes de los menores (artículo 7 de la Ley 1581 de 2012): voz y texto solo con sus amistades aceptadas salvo que su tutor decida otra cosa, ninguna solicitud de amistad de nadie, y los mundos solo saben que es menor de 18 años.',
        ],
      },
      {
        heading: 'Encargados y transferencias',
        paragraphs: [
          'Para operar FlatChat usamos encargados: Cloudflare (la conexión a este servidor y STUN), un servidor de retransmisión (TURN), Resend (los correos) y el sitio de descargas y actualizaciones (kyonax.com). Algunos están fuera de Colombia. [TO DECIDE: name each service provider and its country]',
          'Los servidores de los mundos los operan sus anfitriones, que pueden estar en otros países. Al registrarte autorizas que reciban los datos que lista el aviso de privacidad; para un menor, su tutor lo autoriza de forma expresa.',
        ],
      },
      {
        heading: 'Derechos de los titulares',
        paragraphs: [
          'Según el artículo 8 de la Ley 1581 de 2012, como titular puedes:',
          '• conocer, actualizar y rectificar tus datos, también cuando sean parciales, inexactos, incompletos o induzcan a error;',
          '• pedir prueba de la autorización que nos diste;',
          '• saber, si lo pides, cómo hemos usado tus datos;',
          '• presentar quejas ante la Superintendencia de Industria y Comercio;',
          '• revocar la autorización y pedir la supresión de tus datos;',
          '• consultar gratis tus datos.',
        ],
      },
      {
        heading: 'Responsable de peticiones, consultas y reclamos',
        paragraphs: [
          '{operator} atiende directamente las peticiones, consultas y reclamos sobre datos personales: por correo a {contact}, por escrito en {address} o por teléfono en el {phone}.',
          'Pueden ejercer los derechos el titular, acreditando su identidad (por ejemplo, escribiendo desde el correo de su cuenta); sus causahabientes; su representante o apoderado; y, para un menor, quien lo representa legalmente.',
        ],
      },
      {
        heading: 'Consultas',
        paragraphs: [
          'Para conocer tus datos o cómo los usamos, escribe a {contact} diciendo qué quieres saber.',
          'Respondemos en un máximo de 10 días hábiles desde que recibimos la consulta. Si no alcanzamos, te decimos antes por qué y cuándo responderemos, en un máximo de 5 días hábiles más (artículo 14 de la Ley 1581 de 2012). La consulta es gratuita.',
        ],
      },
      {
        heading: 'Reclamos',
        paragraphs: [
          'Para actualizar, rectificar o suprimir tus datos, revocar tu autorización o advertir que incumplimos un deber, envía un reclamo a {contact} con tu identificación, los hechos, la dirección o el correo donde quieres la respuesta y los documentos que quieras aportar.',
          'Si falta algo, te lo pedimos dentro de los 5 días siguientes; si en 2 meses no lo envías, entendemos que desististe del reclamo. Si no somos competentes, lo trasladamos a quien corresponda en un máximo de 2 días hábiles y te avisamos.',
          'Con el reclamo completo, marcamos tus datos con la leyenda «reclamo en trámite» en un máximo de 2 días hábiles. Respondemos en un máximo de 15 días hábiles desde el día siguiente a recibirlo; si no alcanzamos, te decimos por qué y cuándo, en un máximo de 8 días hábiles más (artículo 15 de la Ley 1581 de 2012).',
          'La supresión y la revocatoria no proceden cuando tienes un deber legal o contractual de permanecer en la base de datos (artículo 9 del Decreto 1377 de 2013). [TO DECIDE: how an account is deleted on request and what stays]',
          'Antes de presentar una queja ante la Superintendencia de Industria y Comercio, debes agotar la consulta o el reclamo con nosotros (artículo 16 de la Ley 1581 de 2012).',
        ],
      },
      {
        heading: 'Seguridad',
        paragraphs: [
          'Guardamos las contraseñas como hashes Argon2id y los tokens solo como resúmenes, ciframos la evidencia sellada y las llaves de los mundos, convertimos lo que se sube en un entorno aislado y corremos este servidor detrás de un túnel cifrado. Informamos a la Superintendencia de Industria y Comercio cualquier violación de seguridad que ponga en riesgo los datos. [TO DECIDE: where backups are kept, and for how long]',
        ],
      },
      {
        heading: 'Cambios a esta política',
        paragraphs: [
          'Te avisaremos de cualquier cambio sustancial de esta política antes de aplicarlo, y te pediremos una nueva autorización si cambia la finalidad del tratamiento.',
        ],
      },
      {
        heading: 'Vigencia',
        paragraphs: [
          'Esta política rige desde el {effective}.',
          'Las bases de datos de FlatChat estarán vigentes mientras FlatChat opere. Dentro de ese tiempo guardamos cada dato solo mientras lo necesita su finalidad: la evidencia de los reportes 183 días (365 días para material de abuso sexual infantil y grooming), la evidencia sellada de los casos de abuso 365 días, y los demás plazos que indica el aviso de privacidad.',
        ],
      },
    ],
  },

  teens: {
    title: 'FlatChat para adolescentes',
    summary: 'Qué es FlatChat y cómo cuida a quienes tienen entre 13 y 17 años.',
    sections: [
      {
        heading: 'Qué es FlatChat',
        paragraphs: [
          'FlatChat es un lugar donde las personas se encuentran en mundos 3D y hablan por voz y texto. Los mundos los alojan personas desde sus propios computadores. Es gratis y no tiene publicidad.',
          'Puedes entrar desde los 13 años (16 en Australia; todavía no en Brasil). Primero, tu madre, padre o tutor tiene que decir que sí. Hasta entonces, no puedes jugar.',
        ],
      },
      {
        heading: 'Qué cambia para ti',
        paragraphs: [
          '• Solo tus amistades pueden hablarte o escribirte, y solo ellas te oyen, salvo que tu madre, padre o tutor lo cambie.',
          '• Nadie puede enviarte una solicitud de amistad. Tú sí puedes enviarla a alguien que conoces.',
          '• Tu micrófono empieza silenciado cuando entras a un mundo.',
          '• Las demás personas de un mundo sí pueden ver tu avatar y tu nombre visible.',
          '• Los mundos solo saben que eres menor de 18 años: nunca tu fecha de nacimiento ni tu correo.',
          '• Tu madre, padre o tutor ve tus amistades, puede quitar una y elige quién puede hablarte. No puede leer tus chats ni oír tu voz, y tú siempre ves que la supervisión está activa.',
        ],
      },
      {
        heading: 'Si algo se siente mal',
        paragraphs: [
          'Si bloqueas a alguien, dejan de verse y de oírse en todos los mundos. Si lo silencias, dejas de oírlo. Mayús+Esc convierte a todos los demás avatares en una figura simple y detiene a la vez todas las superposiciones.',
          'Para reportar, abre la lista de gente (Tab) y elige Reportar. Los últimos 15 segundos de lo que oíste pueden ir con el reporte, y recibes una referencia.',
          'Nadie puede pedirte fotos sexuales, que se vean en persona ni que le guardes secretos a tu familia. Si alguien lo hace, bloquéalo, repórtalo y cuéntale a un adulto de confianza. Si estás en peligro, llama al número de emergencias. En Colombia: la línea 123, o la línea 141 del ICBF.',
        ],
      },
      {
        heading: 'Tus derechos',
        paragraphs: [
          'Puedes preguntar qué guardamos de ti, pedir que lo corrijamos o lo borremos y dar tu opinión sobre eso. Escribe a {contact}; tu madre, padre o tutor puede ayudarte. Las reglas de la comunidad, los términos de uso y el aviso de privacidad te cuentan más.',
        ],
      },
    ],
  },

  guardians: {
    title: 'FlatChat para madres, padres y tutores',
    summary: 'Qué autorizas cuando tu hijo o hija entra a FlatChat, qué puedes ver y hacer, y cómo detenerlo.',
    sections: [
      {
        heading: 'Qué autorizas',
        paragraphs: [
          'FlatChat es un lugar donde las personas se encuentran en mundos 3D y hablan por voz y texto. Quienes tienen entre 13 y 17 años juegan solo cuando su madre, padre o tutor legal los autoriza, con una cuenta de adulto que usa el correo que nos dio el adolescente.',
          'Al autorizar, aceptas que tratemos los datos de tu hijo o hija como describe el aviso de privacidad, y que los servidores de los mundos a los que entra, algunos fuera de Colombia, reciban los datos que allí se listan. Tu hijo o hija aceptó antes tu supervisión. Guardamos la prueba: cuándo, cómo y qué resumen leíste.',
        ],
      },
      {
        heading: 'Cómo se protege a tu hijo o hija',
        paragraphs: [
          '• Voz y texto solo con las amistades que aceptó; su micrófono empieza silenciado.',
          '• Nadie puede enviarle una solicitud de amistad; sí puede enviar una.',
          '• Los mundos saben que es menor de 18 años, nunca su correo ni su fecha de nacimiento. Las demás personas de un mundo sí pueden ver su avatar y su nombre visible.',
          '• Puede bloquear, silenciar y reportar a cualquiera, y un bloqueo mantiene a esa persona separada en todos los mundos.',
        ],
      },
      {
        heading: 'Qué puedes ver y hacer',
        paragraphs: [
          'Inicia sesión en /guardian con tu propia cuenta. Allí ves las amistades de tu hijo o hija y puedes quitar cualquiera, y eliges quién puede hablarle por voz y texto: solo las amistades aceptadas (lo predeterminado), todas las personas de los mundos a los que entra, o nadie. [TO DECIDE: the client still limits teens to friends when a guardian picks everyone]',
          'No ves sus chats ni oyes su voz. FlatChat no guarda ninguno de los dos, salvo lo que alguien adjunta a un reporte.',
        ],
      },
      {
        heading: 'Retirar la autorización, y los 18 años',
        paragraphs: [
          'Puedes retirar tu autorización cuando quieras escribiendo a {contact}; la cuenta de tu hijo o hija se detiene. [TO DECIDE: how a guardian withdrawal is carried out]',
          'A los 18 años terminan las protecciones para menores. [TO DECIDE: whether the guardian link ends at 18]',
          '¿Preguntas o una preocupación? Escribe a {contact}, o repórtalo en /report. En una emergencia, llama primero al número de emergencias.',
        ],
      },
    ],
  },

  lawEnforcement: {
    title: 'Política para autoridades',
    summary: 'Cómo pueden las autoridades pedir datos a este servidor de FlatChat, y cómo manejamos las emergencias, la preservación y la protección de menores.',
    sections: [
      {
        heading: 'Quiénes somos y cómo contactarnos',
        paragraphs: [
          'FlatChat es una plataforma de mundos sociales en prueba cerrada, operada desde Colombia por {operator}, {address}. Las solicitudes se envían a {contact}, con «Solicitud de autoridad» en el asunto, o por escrito a esa dirección.',
          'Cada solicitud debe indicar con exactitud las cuentas o los mundos a los que se refiere (un número de cuenta, un nombre visible, un correo, el ID de un mundo o la referencia de un reporte) y qué se necesita.',
        ],
      },
      {
        heading: 'Requerimiento legal válido',
        paragraphs: [
          'Entregamos datos personales solo ante una solicitud válida: una orden judicial, o una solicitud escrita de una autoridad pública colombiana en ejercicio de sus funciones legales (artículos 10 y 13 de la Ley 1581 de 2012).',
          'Las autoridades extranjeras deben usar los canales que reconoce la ley colombiana, como la asistencia judicial recíproca por medio de las autoridades colombianas. No respondemos solicitudes informales.',
          'Revisamos cada solicitud, pedimos aclaraciones cuando es demasiado amplia y entregamos solo lo que cubre.',
        ],
      },
      {
        heading: 'Emergencias',
        paragraphs: [
          'Cuando creemos de buena fe que una persona, sobre todo un niño, niña o adolescente, corre un riesgo inminente de muerte o de daño grave, podemos entregar los datos mínimos necesarios a una autoridad que pueda ayudar, sin esperar el requerimiento legal. Después pedimos la solicitud formal.',
        ],
      },
      {
        heading: 'Preservación',
        paragraphs: [
          'A solicitud de una autoridad, preservamos lo que tenemos sobre las cuentas o los mundos indicados mientras se obtiene el requerimiento legal, hasta por 365 días: el tiempo que guardamos la evidencia sellada de un caso de abuso. [TO DECIDE: how a preservation request is applied outside an abuse case]',
        ],
      },
      {
        heading: 'Qué datos existen',
        paragraphs: [
          'El aviso de privacidad lista qué guardamos y por cuánto tiempo. En resumen: datos de la cuenta (correo, nombre visible, mes y año de nacimiento, país), horas de inicio de sesión, amistades, bloqueos, subidas, mundos, reportes con su evidencia y clips de voz, y registros de moderación.',
          'Este servidor no guarda direcciones IP, ni conversaciones de voz, ni registros de chat. La voz y el chat solo nos llegan dentro de los reportes que envían las personas, y la evidencia de los reportes se borra a los 183 días (365 días para material de abuso sexual infantil y grooming).',
          'Los mundos corren en los propios computadores de sus anfitriones, que guardan sus propios registros y ven las direcciones IP de sus visitantes. Podemos informar qué cuenta aloja un mundo, y sacar el mundo de FlatChat.',
        ],
      },
      {
        heading: 'Protección de niñas, niños y adolescentes',
        paragraphs: [
          'Cuando encontramos material de abuso sexual infantil, lo retiramos de inmediato, bloqueamos la cuenta o sacamos el mundo, sellamos la evidencia por 365 días y lo denunciamos ante Te Protejo y el CAI Virtual de la Policía Nacional de Colombia, y ante la National Crime Agency (CEOP) del Reino Unido cuando el caso tiene relación con ese país. Cuando el operador quede registrado como proveedor de servicios electrónicos, también lo denunciaremos ante la CyberTipline del NCMEC.',
          'Retiramos las imágenes íntimas compartidas sin consentimiento dentro de las 48 horas siguientes al reporte, y registramos cuánto tardamos.',
        ],
      },
      {
        heading: 'Registro y aviso',
        paragraphs: [
          'Llevamos un registro de cada solicitud: quién la hizo, cuándo, con qué facultad, qué pidió y qué entregamos. [TO DECIDE: where the law-enforcement request log is kept]',
          'Avisamos a las personas afectadas antes de entregar sus datos, salvo que la ley o un juez lo prohíban, o que avisarles ponga en riesgo a un menor o a otra persona, o perjudique una investigación. En los casos de abuso, a la cuenta solo se le dice que rompió gravemente las reglas de la comunidad.',
        ],
      },
    ],
  },
};

/** Every document in both languages, with the same sections in each (docs/policies.md). */
export const DOCUMENTS: Readonly<Record<'en' | 'es', Readonly<Record<DocumentId, Doc>>>> = { en, es };

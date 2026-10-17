// SPDX-License-Identifier: AGPL-3.0-or-later
// Mail (S3.03, DR-21): the core sends verification links (and, from S3.04, a guardian's
// invitation) through a mail interface, so the provider can change. Resend's API is the first
// (its free plan sends 3,000 a month; its sending records sit in Cloudflare DNS, OQ-8); a folder of
// .eml files serves development; `none` sends nothing and the sign-up says so. Addresses and links
// never go to the core's log.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly kind: 'resend' | 'folder' | 'none';
  send(mail: Mail): Promise<void>;
}

export class MailError extends Error {}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Resend's HTTP API: POST {base}/emails with the API key. `base` changes only for tests. */
export function resendMailer(o: { key: string; from: string; base?: string; fetchImpl?: Fetch }): Mailer {
  const base = (o.base ?? 'https://api.resend.com').replace(/\/+$/, '');
  const f = o.fetchImpl ?? fetch;
  return {
    kind: 'resend',
    async send(mail) {
      const res = await f(`${base}/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: o.from, to: [mail.to], subject: mail.subject, text: mail.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new MailError(`the mail service answered ${res.status}`);
    },
  };
}

/** Writes each mail as a .eml file: for development and the end-to-end tests. */
export function folderMailer(dir: string, from: string): Mailer {
  return {
    kind: 'folder',
    async send(mail) {
      mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${randomBytes(4).toString('hex')}.eml`;
      writeFileSync(join(dir, name), `From: ${from}\nTo: ${mail.to}\nSubject: ${mail.subject}\nContent-Type: text/plain; charset=utf-8\n\n${mail.text}\n`, { mode: 0o600 });
    },
  };
}

export const noMailer: Mailer = {
  kind: 'none',
  async send() {
    throw new MailError('this core sends no mail');
  },
};

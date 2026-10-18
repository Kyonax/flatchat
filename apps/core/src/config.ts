// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's settings, from the environment only: a connection string and a secret never belong
// in flags a process listing shows. On the owner's PC they live in a file outside the repository,
// passed with Node's --env-file (see README.md).
//
//   FLATCHAT_CORE_DB        PostgreSQL connection string (required)
//   FLATCHAT_CORE_SECRET    64 hexadecimal characters: seals the world keys (required; `admin secret` makes one)
//   FLATCHAT_CORE_URL       where people reach the core, e.g. https://core.example.org (default http://127.0.0.1:8787)
//   FLATCHAT_CORE_OPERATOR  who runs it, for the privacy notice
//   FLATCHAT_CORE_CONTACT   how to reach them about privacy (an email address or a page)
//   FLATCHAT_CORE_TUNNEL    1 behind a Cloudflare Tunnel (the client's address from the forwarded header)
//   FLATCHAT_CORE_STUN      STUN URLs, comma-separated (default stun:stun.cloudflare.com:3478; "none" for none)
//   FLATCHAT_CORE_TURN_URLS and FLATCHAT_CORE_TURN_SECRET   coturn with use-auth-secret ("the relay we run")
//   FLATCHAT_CORE_CF_TURN_KEY and FLATCHAT_CORE_CF_TURN_TOKEN   Cloudflare Realtime TURN
//   FLATCHAT_CORE_TRUST     trust levels 1-3 as days:active,days:active,days:active (default 3:1,14:5,60:20)
//   FLATCHAT_CORE_STORE     the file store's folder (S4.04; default ~/.local/share/flatchat/core-store)
//   FLATCHAT_CORE_KTX2      off to keep avatars' textures as PNG (quicker conversions; default on)
//   FLATCHAT_CORE_BLENDER   headless Blender's executable (5.2 LTS), for FBX emotes and dances (S5.07; unset: FBX refused)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STUN, type IceConfig } from './ice.ts';
import { parseTrust, TrustError, type TrustRule } from './trust.ts';
import { folderMailer, type Mailer, noMailer, resendMailer } from './mail.ts';

export interface CoreEnv {
  db: string;
  secret: Uint8Array;
  publicUrl: string;
  operator: string;
  contact: string;
  behindTunnel: boolean;
  ice: IceConfig;
  trust: TrustRule[];
  /** Sign-up by invitation only (the closed test), or open with a verified email (S3.03). */
  signup: 'invite' | 'open';
  mail: Mailer;
  /** Players aged 13 to 17, with a guardian (S3.04): off until the owner opens Stage 3's gate (OQ-16). */
  minors: boolean;
  /** The file store's folder (S4.04). */
  store: string;
  /** Avatars' textures as KTX2 (S4.03); off keeps PNG. */
  ktx2: boolean;
  /** Headless Blender for FBX animations (S5.07), when set. */
  blender: string | undefined;
}

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export class ConfigError extends Error {}

export function readEnv(env: NodeJS.ProcessEnv = process.env, needSecret = true): CoreEnv {
  const db = env['FLATCHAT_CORE_DB'] ?? '';
  if (!db) throw new ConfigError('FLATCHAT_CORE_DB is not set (a PostgreSQL connection string)');
  const hex = env['FLATCHAT_CORE_SECRET'] ?? '';
  if (needSecret && !/^[0-9a-f]{64}$/i.test(hex)) throw new ConfigError('FLATCHAT_CORE_SECRET must be 64 hexadecimal characters (node src/admin.ts secret makes one)');
  const publicUrl = (env['FLATCHAT_CORE_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new ConfigError(`FLATCHAT_CORE_URL is not a URL: ${publicUrl}`);
  }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new ConfigError('FLATCHAT_CORE_URL must be https, except on this machine');
  }
  return {
    db,
    secret: needSecret ? new Uint8Array(Buffer.from(hex, 'hex')) : new Uint8Array(32),
    publicUrl,
    operator: env['FLATCHAT_CORE_OPERATOR'] ?? 'The operator of this FlatChat core',
    contact: env['FLATCHAT_CORE_CONTACT'] ?? 'the contact address published by the operator',
    behindTunnel: env['FLATCHAT_CORE_TUNNEL'] === '1',
    ice: {
      stun: env['FLATCHAT_CORE_STUN'] === 'none' ? [] : env['FLATCHAT_CORE_STUN'] ? list(env['FLATCHAT_CORE_STUN']) : DEFAULT_STUN,
      turnUrls: list(env['FLATCHAT_CORE_TURN_URLS']),
      ...(env['FLATCHAT_CORE_TURN_SECRET'] ? { turnSecret: env['FLATCHAT_CORE_TURN_SECRET'] } : {}),
      ...(env['FLATCHAT_CORE_CF_TURN_KEY'] && env['FLATCHAT_CORE_CF_TURN_TOKEN'] ? { cloudflare: { keyId: env['FLATCHAT_CORE_CF_TURN_KEY'], token: env['FLATCHAT_CORE_CF_TURN_TOKEN'] } } : {}),
    },
    trust: trusted(env['FLATCHAT_CORE_TRUST']),
    signup: signupMode(env['FLATCHAT_CORE_SIGNUP']),
    mail: mailer(env),
    minors: env['FLATCHAT_CORE_MINORS'] === 'on',
    store: env['FLATCHAT_CORE_STORE'] || join(env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'flatchat', 'core-store'),
    ktx2: env['FLATCHAT_CORE_KTX2'] !== 'off',
    blender: env['FLATCHAT_CORE_BLENDER'] || undefined,
  };
}

function signupMode(v: string | undefined): 'invite' | 'open' {
  if (v === undefined || v === '' || v === 'invite') return 'invite';
  if (v === 'open') return 'open';
  throw new ConfigError('FLATCHAT_CORE_SIGNUP is invite or open');
}

/** FLATCHAT_CORE_MAIL: resend (FLATCHAT_CORE_RESEND_KEY, FLATCHAT_CORE_MAIL_FROM), folder
 *  (FLATCHAT_CORE_MAIL_FOLDER, for development), or none (the default). */
function mailer(env: NodeJS.ProcessEnv): Mailer {
  const kind = env['FLATCHAT_CORE_MAIL'] ?? 'none';
  const from = env['FLATCHAT_CORE_MAIL_FROM'] ?? '';
  if (kind === 'none') return noMailer;
  if (!from) throw new ConfigError('FLATCHAT_CORE_MAIL_FROM is the sender, like FlatChat <noreply@example.org>');
  if (kind === 'resend') {
    const key = env['FLATCHAT_CORE_RESEND_KEY'] ?? '';
    if (!key) throw new ConfigError('FLATCHAT_CORE_RESEND_KEY is the Resend API key');
    return resendMailer({ key, from, ...(env['FLATCHAT_CORE_RESEND_URL'] ? { base: env['FLATCHAT_CORE_RESEND_URL'] } : {}) });
  }
  if (kind === 'folder') {
    const dir = env['FLATCHAT_CORE_MAIL_FOLDER'] ?? '';
    if (!dir) throw new ConfigError('FLATCHAT_CORE_MAIL_FOLDER is the folder the mails go to');
    return folderMailer(dir, from);
  }
  throw new ConfigError('FLATCHAT_CORE_MAIL is resend, folder or none');
}

function trusted(text: string | undefined): TrustRule[] {
  try {
    return parseTrust(text);
  } catch (err) {
    throw new ConfigError(err instanceof TrustError ? err.message : String(err));
  }
}

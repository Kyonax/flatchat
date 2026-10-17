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

export interface CoreEnv {
  db: string;
  secret: Uint8Array;
  publicUrl: string;
  operator: string;
  contact: string;
  behindTunnel: boolean;
}

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
  };
}

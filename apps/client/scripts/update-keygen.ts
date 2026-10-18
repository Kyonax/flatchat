// SPDX-License-Identifier: MPL-2.0
// Makes the owner's update key (S7.01), once, on his own machine: an Ed25519 key pair. The private
// key goes to a file only he can read (it signs every release's feed and never leaves his machine);
// the public key is printed, for src/main/update-key.ts.
//
//   node apps/client/scripts/update-keygen.ts [--out ~/.flatchat-release/update-key.pem]
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string', default: join(homedir(), '.flatchat-release', 'update-key.pem') } } });
const out = values.out;
if (existsSync(out)) {
  process.stderr.write(`${out} exists: a key is made once. Keep that one, or move it away first.\n`);
  process.exit(2);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const der = publicKey.export({ format: 'der', type: 'spki' });
const raw = Buffer.from(der.subarray(der.length - 32)).toString('base64');
process.stdout.write(`The private key is in ${out} (only you can read it; back it up somewhere safe).\nThe public key, for apps/client/src/main/update-key.ts's UPDATE_PUBLIC_KEY:\n${raw}\n`);

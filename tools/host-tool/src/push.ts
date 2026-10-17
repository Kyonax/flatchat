// SPDX-License-Identifier: MPL-2.0
// `host push` (S3.06, Q-M7): sends a new build of a world to the running world itself, over the
// connection a player uses, for a builder, an admin or the owner there. The world checks the
// build, puts it in place of the old one and restarts on it; players come back in on their own.
// Pieces go out within a window of unacknowledged bytes (the world answers each with `got`), since
// a link refuses messages beyond its send queue.
import { createHash } from 'node:crypto';
import { decodeMessage, encodeMessage, type Message, messageDef, PROTOCOL_VERSION, SCHEMA_FINGERPRINT } from '@flatchat/protocol';
import type { Link } from '@flatchat/world-server/net';
import { HostError } from './account.ts';

export const PIECE = 16_384;
/** Bytes sent and not yet acknowledged before the sender waits. */
export const WINDOW = 512 * 1024;

export interface PushOptions {
  /** How long to wait for any one answer from the world (default 30 s; the final check gets 5 min). */
  timeoutMs?: number;
  progress?: (sent: number, total: number) => void;
  build?: string;
}

/** The world's verdict on a build. */
export interface PushResult {
  ok: boolean;
  detail: string;
}

/** The messages a push waits for; everything else a player receives (snapshots, voice) is dropped. */
const WANTED = new Set(['welcome', 'refuse', 'leave', 'got', 'published']);

class Refused extends Error {}

/** Uploads a built world (the converter's output: `world.json` and `content/<sha256>`) to the
 *  world a connect token admits to, and resolves with the world's answer. */
export async function pushBuild(link: Link, token: Uint8Array, built: ReadonlyMap<string, Uint8Array>, options: PushOptions = {}): Promise<PushResult> {
  const wait = options.timeoutMs ?? 30_000;
  const json = built.get('world.json');
  if (!json) throw new HostError('the build has no world.json');
  const files: Array<{ hash: Buffer; bytes: Uint8Array }> = [];
  for (const [path, bytes] of built) {
    const hash = createHash('sha256').update(bytes).digest();
    if (path.startsWith('content/') && path !== `content/${hash.toString('hex')}`) throw new HostError(`${path} does not match its hash`);
    if (path.startsWith('content/')) files.push({ hash, bytes });
  }
  // world.json last: the world checks the build when it is named, and everything is there by then.
  files.push({ hash: createHash('sha256').update(json).digest(), bytes: json });
  const total = files.reduce((n, f) => n + f.bytes.length, 0);

  const inbox: Message[] = [];
  let closed: string | undefined;
  let wake: (() => void) | undefined;
  link.onMessage((_channel, bytes) => {
    let m: Message;
    try {
      m = decodeMessage(bytes, 'server');
    } catch {
      return;
    }
    if (!WANTED.has(m.type)) return;
    inbox.push(m);
    wake?.();
  });
  link.onClose((reason) => {
    closed = reason;
    wake?.();
  });
  const send = (m: Message): void => link.send(messageDef(m.type).channel, encodeMessage(m));
  /** The first message `pick` takes; a refusal, a leave or a refused build ends the push. */
  const next = async <T>(pick: (m: Message) => T | undefined, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      for (let i = 0; i < inbox.length; i++) {
        const m = inbox[i]!;
        const v = pick(m);
        if (v !== undefined) {
          inbox.splice(i, 1);
          return v;
        }
        if (m.type === 'refuse') throw new HostError(`the world refused the connection: ${m.reason}${m.detail ? ` (${m.detail})` : ''}`);
        if (m.type === 'leave') throw new HostError(`the world closed the connection: ${m.reason}${m.detail ? ` (${m.detail})` : ''}`);
        if (m.type === 'published' && !m.ok) throw new Refused(m.detail);
      }
      if (closed !== undefined) throw new HostError(`the connection closed: ${closed}`);
      const left = end - Date.now();
      if (left <= 0) throw new HostError(`no answer from the world (waiting for ${what})`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 1000));
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = undefined;
    }
  };

  try {
    send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: options.build ?? 'flatchat-host', token, spawn: '', height: 0 });
    await next((m) => (m.type === 'welcome' ? m : undefined), wait, 'welcome');
    let sent = 0;
    for (const f of files) {
      const size = f.bytes.length;
      const got = (m: Message): number | undefined => (m.type === 'got' && f.hash.equals(m.hash) ? m.offset : undefined);
      let acked = -1;
      let offset = 0;
      do {
        while (offset - Math.max(acked, 0) >= WINDOW) acked = Math.max(acked, await next(got, wait, 'got'));
        const data = f.bytes.subarray(offset, Math.min(size, offset + PIECE));
        send({ type: 'put', hash: f.hash, offset, total: size, data });
        offset += data.length;
        sent += data.length;
        options.progress?.(sent, total);
      } while (offset < size);
      while (acked < size) acked = Math.max(acked, await next(got, wait, 'got'));
    }
    send({ type: 'publish', world: files.at(-1)!.hash });
    const verdict = await next((m) => (m.type === 'published' ? m : undefined), Math.max(wait, 300_000), 'published');
    return { ok: verdict.ok, detail: verdict.detail };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, detail: err.message };
    throw err;
  }
}

// SPDX-License-Identifier: MPL-2.0
// The host tool (S2.02): the capacity advice, the browser sign-in against a pretend core, and the
// files that keep the session and a world's key readable by the user only.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { coreUrl, HostError, saveSession, signIn } from '../src/account.ts';
import { advise } from '../src/advisor.ts';

const dir = mkdtempSync(join(tmpdir(), 'fc-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the capacity advisor', () => {
  it('keeps a margin under the measured upload', () => {
    expect(advise(40)).toEqual({ uploadMbps: 40, recommended: 96, maximum: 128, crowded: 42 });
    expect(advise(1)).toEqual({ uploadMbps: 1, recommended: 2, maximum: 3, crowded: 1 });
    expect(advise(1000).maximum).toBe(200);
  });
});

describe('signing in from a terminal', () => {
  it('opens only the core’s page and trades the loopback code with its verifier', async () => {
    const core = 'https://core.example.org';
    let exchanged: Record<string, unknown> = {};
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (path === '/api/v1/login-requests') return Response.json({ request: 'req-1', signinUrl: `${core}/signin?request=req-1`, port: body['port'] });
      exchanged = body;
      return Response.json({ access: 'acc', refresh: 'ref', account: { displayName: 'Host' } });
    };
    // The "browser": back to the loopback port the request named, with a code.
    let port = 0;
    const wrapped = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/login-requests')) port = (JSON.parse(String(init?.body)) as { port: number }).port;
      return fetchImpl(url, init);
    };
    const r = await signIn(core, {
      fetchImpl: wrapped,
      open: async (url) => {
        expect(url).toBe(`${core}/signin?request=req-1`);
        setTimeout(() => request(`http://127.0.0.1:${port}/callback?request=req-1&code=${'C'.repeat(43)}`).end(), 5);
      },
    });
    expect(r).toEqual({ access: 'acc', refresh: 'ref', name: 'Host' });
    expect(exchanged).toMatchObject({ request: 'req-1', code: 'C'.repeat(43) });
    expect(String(exchanged['verifier']).length).toBeGreaterThanOrEqual(43);
  });

  it('refuses a sign-in page on another origin, and a core over plain http elsewhere', async () => {
    const evil = async (): Promise<Response> => Response.json({ request: 'r', signinUrl: 'https://evil.example.com/signin?request=r' });
    await expect(signIn('https://core.example.org', { fetchImpl: evil, open: async () => undefined, timeoutMs: 2000 })).rejects.toThrow(/not on the core/);
    expect(() => coreUrl('http://core.example.org')).toThrow(HostError);
    expect(coreUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
  });

  it('keeps the session readable by the user only', () => {
    const file = join(dir, 'host.json');
    saveSession({ core: 'https://core.example.org', refresh: 'r' }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

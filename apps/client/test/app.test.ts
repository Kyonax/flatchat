// SPDX-License-Identifier: MPL-2.0
// Stage 1's client without a window: settings and bindings, the controls, other players'
// interpolation, the camera, the two languages, the core's API, the loopback port and signing in.
import { request } from 'node:http';
import { PLAZA } from '@flatchat/sim';
import { describe, expect, it } from 'vitest';
import { Auth, pkcePair, type TokenStore } from '../src/main/auth';
import { cleanIceServers, CoreApi, coreBase, CoreError, type Fetch } from '../src/main/core-api';
import { listenForCallback } from '../src/main/loopback';
import en from '../src/renderer/src/i18n/en';
import es from '../src/renderer/src/i18n/es';
import { pickLocale } from '../src/renderer/src/i18n/index';
import { cameraPose } from '../src/renderer/src/world/camera';
import { Controls, PITCH_LIMIT } from '../src/renderer/src/world/controls';
import { CrowdView } from '../src/renderer/src/world/crowd-view';
import { buildWorldScene } from '../src/renderer/src/world/plaza-scene';
import { angleDelta, Remotes } from '../src/renderer/src/world/remotes';
import { ACTIONS, actionFor, bind, cleanSettings, DEFAULT_KEYS, defaultSettings, mergeSettings, unbind } from '../src/shared/settings';

describe('settings', () => {
  it('fall back field by field and never keep a code twice', () => {
    expect(cleanSettings(undefined)).toEqual(defaultSettings());
    const s = cleanSettings({ language: 'fr', voice: { mode: 'push', volume: 7, asked: 'yes' }, view: { sensitivity: -3 }, keys: { forward: ['KeyW', 'KeyW', 'Bogus'], back: ['KeyW', 'KeyS'], menu: ['KeyQ'] } });
    expect(s.language).toBe('system');
    expect(s.voice).toMatchObject({ mode: 'push', volume: 1, asked: false });
    expect(s.view.sensitivity).toBe(1);
    expect(s.keys.forward).toEqual(['KeyW']);
    expect(s.keys.back).toEqual(['KeyS']);
    // Escape stays the menu's, whatever a file says.
    expect(s.keys.menu).toEqual(['Escape']);
  });

  it('rebind a key by moving it, and never bind away the menu', () => {
    const keys = defaultSettings().keys;
    const moved = bind(keys, 'jump', 0, 'KeyW');
    expect(moved.jump).toEqual(['KeyW', 'Space']);
    expect(moved.forward).toEqual(['ArrowUp']);
    expect(bind(keys, 'jump', 0, 'Escape')).toBe(keys);
    expect(bind(keys, 'menu', 0, 'KeyQ')).toBe(keys);
    expect(unbind(moved, 'jump', 1).jump).toEqual(['KeyW']);
    expect(actionFor(moved, 'KeyW')).toBe('jump');
    expect(actionFor(moved, 'Mouse0')).toBeUndefined();
    const merged = mergeSettings(defaultSettings(), { voice: { mode: 'push' }, view: { person: 'first' } });
    expect(merged.voice).toMatchObject({ mode: 'push', volume: 1 });
    expect(merged.view.person).toBe('first');
    for (const a of ACTIONS) expect(DEFAULT_KEYS[a].length).toBeGreaterThan(0);
  });
});

describe('the controls', () => {
  it('turn keys into actions, each press counted once', () => {
    const c = new Controls(defaultSettings().keys, 12, false);
    expect(c.press('KeyW')).toBe('forward');
    c.press('KeyW');
    c.press('KeyD');
    expect(c.axes()).toEqual({ forward: 1, right: 1 });
    c.press('KeyV');
    expect(c.took('view')).toBe(true);
    expect(c.took('view')).toBe(false);
    c.release('KeyW');
    expect(c.axes()).toEqual({ forward: 0, right: 1 });
    c.clear();
    expect(c.axes()).toEqual({ forward: 0, right: 0 });
  });

  it('turn the mouse into a look with the sensitivity, the inversion and a pitch limit', () => {
    const c = new Controls(defaultSettings().keys, 100, false);
    c.look(100, 0);
    expect(c.yaw).toBeCloseTo((-100 * Math.PI) / 180);
    c.look(0, -10_000);
    expect(c.pitch).toBe(PITCH_LIMIT);
    const inverted = new Controls(defaultSettings().keys, 100, true);
    inverted.look(0, 10);
    expect(inverted.pitch).toBeGreaterThan(0);
  });
});

describe('other players', () => {
  it('are drawn between two updates, a little in the past, turning the short way', () => {
    const r = new Remotes();
    r.push(1, 0, { x: 0, y: 0, z: 0, yaw: Math.PI - 0.1 });
    r.push(1, 50, { x: 1, y: 0, z: 0, yaw: -Math.PI + 0.1 });
    const mid = r.at(1, 125)!;
    expect(mid.x).toBeCloseTo(0.5);
    expect(Math.abs(Math.abs(mid.yaw) - Math.PI)).toBeLessThan(0.01);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(r.at(1, 10_000)!.x).toBe(1);
    expect(r.prune(100)).toEqual([1]);
    expect(r.at(1, 0)).toBeUndefined();
  });

  it('wait longer for players sent once a second', () => {
    const r = new Remotes();
    for (let t = 0; t <= 20_000; t += 1000) r.push(2, t, { x: t / 1000, y: 0, z: 0, yaw: 0 });
    // Halfway through the last second, it still moves between known updates instead of freezing.
    const p = r.at(2, 20_500)!;
    expect(p.x).toBeGreaterThan(18.5);
    expect(p.x).toBeLessThan(20);
  });
});

describe('the camera', () => {
  it('sits at the eyes in first person and behind in third, pulled in by a wall', () => {
    const feet = { x: 64, y: 0.15, z: 76 };
    const first = cameraPose('first', feet, 0, 0, PLAZA.solids);
    expect(first.position.y).toBeCloseTo(0.15 + 1.62);
    const third = cameraPose('third', feet, 0, 0, PLAZA.solids);
    expect(third.position.z).toBeGreaterThan(feet.z + 3);
    const wall = [{ min: { x: 60, y: 0, z: 77 }, max: { x: 68, y: 5, z: 78 } }];
    const pulled = cameraPose('third', feet, 0, 0, wall);
    expect(pulled.position.z).toBeLessThan(77 - 0.25 + 0.01);
  });
});

describe('the world view', () => {
  it('draws the plaza in one mesh per surface, and everyone in three instanced meshes', () => {
    const v = buildWorldScene(PLAZA);
    expect(v.meshes).toBe(6);
    const crowd = new CrowdView();
    crowd.update(
      [
        { entity: 1, x: 64, y: 0.15, z: 70, yaw: 0, name: 'ana', speaking: 0.8 },
        { entity: 2, x: 60, y: 0.15, z: 70, yaw: 1, name: 'bea', speaking: 0 },
        { entity: 3, x: 0, y: 0, z: 0, yaw: 0, name: 'me', speaking: 0, hidden: true },
      ],
      { x: 64, z: 76 },
    );
    expect(crowd.group.children).toHaveLength(3);
    const [bodies, , rings] = crowd.group.children as Array<{ count: number }>;
    expect(bodies!.count).toBe(2);
    expect(rings!.count).toBe(1);
  });
});

describe('the two languages', () => {
  it('have the same keys, every one a non-empty string', () => {
    const shape = (o: unknown, path = ''): string[] =>
      typeof o === 'object' && o !== null ? Object.entries(o).flatMap(([k, v]) => shape(v, `${path}.${k}`)) : [`${path}:${typeof o === 'string' && o.length > 0 ? 'text' : 'EMPTY'}`];
    expect(shape(es)).toEqual(shape(en));
    expect(shape(en).filter((k) => k.endsWith('EMPTY'))).toEqual([]);
  });

  it('follow the player, then the system', () => {
    expect(pickLocale('system', 'es-CO')).toBe('es');
    expect(pickLocale('system', 'de-DE')).toBe('en');
    expect(pickLocale('en', 'es-CO')).toBe('en');
  });
});

// --------------------------------------------------------------------------- signing in

describe("the core's API", () => {
  it('accepts https anywhere and http only on this machine', () => {
    expect(coreBase('https://core.example.org')?.href).toBe('https://core.example.org/');
    expect(coreBase('http://127.0.0.1:8787')?.href).toBe('http://127.0.0.1:8787/');
    for (const bad of ['http://core.example.org', 'ftp://x', 'https://u:p@x.org', 'https://x.org/?q', 'nope']) expect(coreBase(bad)).toBeUndefined();
  });

  it('opens only the core’s own sign-in page, and reads tokens and tickets', async () => {
    const answers: Record<string, unknown> = {};
    const fetchFake: Fetch = async (url) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(answers[path]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = new CoreApi(coreBase('https://core.example.org')!, fetchFake);
    answers['/api/v1/login-requests'] = { request: 'r', signinUrl: 'https://evil.example.com/signin?request=r' };
    await expect(api.loginRequest('c', 50_000)).rejects.toMatchObject({ code: 'bad-answer' });
    answers['/api/v1/login-requests'] = { request: 'r', signinUrl: 'https://core.example.org/signin?request=r' };
    expect((await api.loginRequest('c', 50_000)).signinUrl.href).toBe('https://core.example.org/signin?request=r');
    answers['/api/v1/worlds/00000000-0000-4000-8000-000000000001/join'] = { token: Buffer.from([1, 2, 3]).toString('base64url'), address: 'https://w.example.org/rtc', expiresAt: 5 };
    const ticket = await api.join('a', '00000000-0000-4000-8000-000000000001');
    expect([...ticket.token]).toEqual([1, 2, 3]);
    await expect(api.join('a', '../../me')).rejects.toBeInstanceOf(CoreError);
  });
});

describe('hosting from home on the client side', () => {
  it('keeps only STUN and TURN servers, and knows its own core’s relay', () => {
    expect(cleanIceServers([{ urls: 'stun:a:1' }, { urls: ['turn:t:3478', 'http://x'], username: 'u:1', credential: 'c' }, { urls: 'javascript:alert(1)' }, 'junk', null])).toEqual([
      { urls: ['stun:a:1'] },
      { urls: ['turn:t:3478'], username: 'u:1', credential: 'c' },
    ]);
    const api = new CoreApi(coreBase('https://core.example.org')!);
    expect(api.isRelay('https://core.example.org/api/v1/worlds/00000000-0000-4000-8000-000000000001/signal')).toBe(true);
    expect(api.isRelay('https://evil.example.com/api/v1/worlds/00000000-0000-4000-8000-000000000001/signal')).toBe(false);
    expect(api.isRelay('https://core.example.org/api/v1/me')).toBe(false);
  });
});

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

describe('the loopback port', () => {
  it('takes only its own request’s code, once', async () => {
    const lb = await listenForCallback(5000);
    const code = 'A'.repeat(43);
    expect(await get(`http://127.0.0.1:${lb.port}/callback?request=x&code=${code}`)).toBe(400);
    lb.expect('mine');
    expect(await get(`http://127.0.0.1:${lb.port}/elsewhere`)).toBe(404);
    expect(await get(`http://127.0.0.1:${lb.port}/callback?request=other&code=${code}`)).toBe(400);
    expect(await get(`http://127.0.0.1:${lb.port}/callback?request=mine&code=short`)).toBe(400);
    expect(await get(`http://127.0.0.1:${lb.port}/callback?request=mine&code=${code}&lang=es`)).toBe(200);
    expect(await lb.result).toEqual({ code, lang: 'es' });
    await expect(get(`http://127.0.0.1:${lb.port}/callback?request=mine&code=${code}`)).rejects.toThrow();
  });
});

describe('signing in', () => {
  function memoryStore(durable = true): TokenStore & { value: string | undefined } {
    const s = {
      value: undefined as string | undefined,
      durable,
      load: () => s.value,
      save: (v: string | undefined) => {
        s.value = durable ? v : undefined;
      },
    };
    return s;
  }

  function fakeApi(): CoreApi & { refreshes: number; exchanged: Array<[string, string, string]> } {
    let n = 0;
    const tokens = (i: number) => ({ access: `a${i}`, refresh: `r${i}`, accessExpiresAt: Date.now() + 900_000, refreshExpiresAt: Date.now() + 9e9, account: { id: 'u', displayName: 'Ana' } });
    const api = {
      base: new URL('https://core.example.org/'),
      refreshes: 0,
      exchanged: [] as Array<[string, string, string]>,
      challenge: '',
      port: 0,
      loginRequest: async (challenge: string, port: number) => {
        api.challenge = challenge;
        api.port = port;
        return { request: 'req1', signinUrl: new URL('https://core.example.org/signin?request=req1') };
      },
      exchange: async (request: string, code: string, verifier: string) => {
        api.exchanged.push([request, code, verifier]);
        return tokens(++n);
      },
      refresh: async () => {
        api.refreshes += 1;
        await new Promise((r) => setTimeout(r, 20));
        return tokens(++n);
      },
      revoke: async () => undefined,
      worlds: async () => [],
      join: async () => ({ token: new Uint8Array([1]), address: 'x', expiresAt: 1 }),
    };
    return api as unknown as CoreApi & { refreshes: number; exchanged: Array<[string, string, string]> };
  }

  it('signs in through the loopback port with a verifier only it knows', async () => {
    const api = fakeApi();
    const store = memoryStore();
    // The "browser": opening the page sends it straight back to the client's port with a code.
    const auth = new Auth(api, store, async (url) => {
      const port = (api as unknown as { port: number }).port;
      expect(url.href).toBe('https://core.example.org/signin?request=req1');
      setTimeout(() => void get(`http://127.0.0.1:${port}/callback?request=req1&code=${'C'.repeat(43)}`), 10);
    });
    const state = await auth.signIn();
    expect(state).toMatchObject({ status: 'signed-in', account: { displayName: 'Ana' }, remembered: true });
    const [[request, code, verifier]] = api.exchanged as [[string, string, string]];
    expect(request).toBe('req1');
    expect(code).toBe('C'.repeat(43));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(store.value).toBe('r1');
    const { challenge } = pkcePair();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refreshes once when two calls find the access token old, and forgets everything on sign-out', async () => {
    let now = Date.now();
    const api = fakeApi();
    const store = memoryStore();
    store.value = 'r0';
    const auth = new Auth(api, store, async () => undefined, () => now);
    await auth.restore();
    expect(api.refreshes).toBe(1);
    now += 3_600_000;
    const [a, b] = await Promise.all([auth.access(), auth.access()]);
    expect(api.refreshes).toBe(2);
    expect(a).toBe(b);
    await auth.signOut();
    expect(store.value).toBeUndefined();
    await expect(auth.access()).rejects.toMatchObject({ code: 'signed-out' });
  });

  it('keeps the session for the next start when the core cannot be reached, and drops a refused one', async () => {
    const store = memoryStore();
    store.value = 'r0';
    const unreachable = { ...fakeApi(), refresh: async () => Promise.reject(new CoreError(0, 'unreachable', 'down')) } as unknown as CoreApi;
    expect(await new Auth(unreachable, store, async () => undefined).restore()).toEqual({ status: 'signed-out', error: 'unreachable' });
    expect(store.value).toBe('r0');
    const refused = { ...fakeApi(), refresh: async () => Promise.reject(new CoreError(401, 'refresh-reused', 'no')) } as unknown as CoreApi;
    await new Auth(refused, store, async () => undefined).restore();
    expect(store.value).toBeUndefined();
  });
});

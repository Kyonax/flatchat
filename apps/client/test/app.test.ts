// SPDX-License-Identifier: MPL-2.0
// Stage 1's client without a window: settings and bindings, the controls, other players'
// interpolation, the camera, the two languages, the core's API, the loopback port and signing in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STRICT_LICENCE } from '@flatchat/content';
import { PLAZA } from '@flatchat/sim';
import { describe, expect, it } from 'vitest';
import { Auth, pkcePair, type TokenStore } from '../src/main/auth';
import { cleanAvatars, cleanGallery, cleanIceServers, cleanItems, cleanOutfits, cleanWorlds, cleanWorn, CoreApi, coreBase, CoreError, type Fetch } from '../src/main/core-api';
import { listenForCallback } from '../src/main/loopback';
import { listOffline } from '../src/main/offline';
import en from '../src/renderer/src/i18n/en';
import es from '../src/renderer/src/i18n/es';
import { pickLocale } from '../src/renderer/src/i18n/index';
import { cameraPose } from '../src/renderer/src/world/camera';
import { Controls, PITCH_LIMIT } from '../src/renderer/src/world/controls';
import { CrowdView } from '../src/renderer/src/world/crowd-view';
import { buildWorldScene } from '../src/renderer/src/world/plaza-scene';
import { angleDelta, Remotes } from '../src/renderer/src/world/remotes';
import { PathWalker } from '../src/renderer/src/world/walker';
import { ACTIONS, actionFor, bind, cleanSettings, DEFAULT_KEYS, defaultSettings, HEIGHT_RANGE, mergeSettings, unbind } from '../src/shared/settings';

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

  it('give an older file the new actions and a height kept in centimetre steps within the range (S2.06, S2.07)', () => {
    const old = cleanSettings({ keys: { forward: ['KeyW'], jump: ['Space'] } });
    expect([old.keys.fly, old.keys.down, old.keys.sit, old.keys.goto, old.keys.teleport]).toEqual([['KeyF'], ['KeyC'], ['KeyE'], ['KeyG'], ['KeyH']]);
    expect(old.avatar.height).toBe(HEIGHT_RANGE.default);
    expect(cleanSettings({ avatar: { height: 1.8333 } }).avatar.height).toBe(1.83);
    expect(cleanSettings({ avatar: { height: 99 } }).avatar.height).toBe(HEIGHT_RANGE.max);
    expect(cleanSettings({ avatar: { height: 'tall' } }).avatar.height).toBe(HEIGHT_RANGE.default);
    expect(mergeSettings(defaultSettings(), { avatar: { height: 0.1 } }).avatar.height).toBe(HEIGHT_RANGE.min);
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

  it('grows and shrinks with the player’s height (S2.07)', () => {
    const feet = { x: 64, y: 0, z: 76 };
    expect(cameraPose('first', feet, 0, 0, [], 2).position.y).toBeCloseTo(1.62 * 2);
    expect(cameraPose('first', feet, 0, 0, [], 0.5).position.y).toBeCloseTo(1.62 * 0.5);
    const tall = cameraPose('third', feet, 0, 0, [], 2);
    const short = cameraPose('third', feet, 0, 0, [], 0.3);
    expect(tall.position.z - feet.z).toBeCloseTo(7.2);
    expect(short.position.z - feet.z).toBeCloseTo(1.2);
  });
});

describe('walking to a spot (S2.06)', () => {
  /** Walks a point along the walker's input at 3.6 m/s, as the movement rules would. */
  function walk(w: PathWalker, from: { x: number; y: number; z: number }, yaw: number, seconds: number): { x: number; y: number; z: number } {
    const at = { ...from };
    for (let t = 0; t < seconds && !w.done; t += 1 / 60) {
      const i = w.input(at, yaw, 1 / 60);
      // packages/sim's wishVelocity: facing (-sin yaw, -cos yaw), right (cos yaw, -sin yaw).
      at.x += (-Math.sin(yaw) * i.forward + Math.cos(yaw) * i.right) * 3.6 / 60;
      at.z += (-Math.cos(yaw) * i.forward - Math.sin(yaw) * i.right) * 3.6 / 60;
    }
    return at;
  }

  it('turns each corner of a path into the keys’ own input, whatever way the player faces', () => {
    const w = new PathWalker([{ x: 0, y: 0, z: -4 }]);
    expect(w.input({ x: 0, y: 0, z: 0 }, 0, 1 / 60)).toEqual({ forward: 1, right: expect.closeTo(0, 6) });
    const side = new PathWalker([{ x: 4, y: 0, z: 0 }]);
    const i = side.input({ x: 0, y: 0, z: 0 }, 0, 1 / 60);
    expect(i.forward).toBeCloseTo(0, 6);
    expect(i.right).toBeCloseTo(1, 6);
    for (const yaw of [0, 1, -2.5]) {
      const path = new PathWalker([{ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: -6 }, { x: -2, y: 0, z: -6 }]);
      const end = walk(path, { x: 0, y: 0, z: 0 }, yaw, 20);
      expect(path.done).toBe(true);
      expect(Math.hypot(end.x + 2, end.z + 6)).toBeLessThan(0.4);
    }
  });

  it('gives up when it stops getting closer', () => {
    const w = new PathWalker([{ x: 10, y: 0, z: 0 }]);
    const stuck = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 120 && !w.done; k++) w.input(stuck, 0, 1 / 60);
    expect(w.done).toBe(true);
    expect(new PathWalker([]).done).toBe(true);
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

describe('avatars on the client side (S4.01, S4.04)', () => {
  it('keeps only well-formed avatars', () => {
    const id = '00000000-0000-4000-8000-0000000000aa';
    expect(
      cleanAvatars([
        { id, name: 'Mine', status: 'ready', rank: 'good', problems: [], manifest: 'a'.repeat(64), createdAt: '2026-10-17T00:00:00Z', wearing: true, kit: 'feminine' },
        { id: 'nope', status: 'ready' },
        { id, status: 'exploded' },
        { id, name: 7, status: 'refused', problems: ['no humanoid', 3], manifest: 'not-a-hash', kit: 'robot' },
      ]),
    ).toEqual([
      { id, name: 'Mine', status: 'ready', rank: 'good', problems: [], manifest: 'a'.repeat(64), createdAt: '2026-10-17T00:00:00Z', wearing: true, kit: 'feminine', published: null, fromGallery: null },
      { id, name: '', status: 'refused', rank: null, problems: ['no humanoid'], manifest: null, createdAt: '', wearing: false, kit: null, published: null, fromGallery: null },
    ]);
  });

  it('keeps only well-formed items, outfits and worn lists (S5.05), each adjustment within the limits', () => {
    const id = '00000000-0000-4000-8000-0000000000bb';
    const hash = 'b'.repeat(64);
    expect(
      cleanItems([
        { id, name: 'Tee', status: 'ready', slot: 'top', fits: ['feminine', 'robot', 'neutral'], problems: [], warnings: ['2 points near the hem', 4], manifest: hash, createdAt: 'x', published: id, fromGallery: 'nope', starter: 'grey-fedora' },
        { id, status: 'ready', slot: 'cape', starter: 'Not An Id!' },
        { id: 'nope', status: 'ready' },
      ]),
    ).toEqual([
      { id, name: 'Tee', status: 'ready', slot: 'top', fits: ['feminine', 'neutral'], problems: [], warnings: ['2 points near the hem'], manifest: hash, createdAt: 'x', published: id, fromGallery: null, starter: 'grey-fedora' },
      { id, name: '', status: 'ready', slot: null, fits: [], problems: [], warnings: [], manifest: null, createdAt: '', published: null, fromGallery: null, starter: null },
    ]);
    expect(cleanWorn([{ item: hash, adjust: { x: 40, y: 0, z: 0, rx: 90, ry: 0, rz: 0, scale: 300 } }, { item: hash }, { item: 'not-a-hash' }, 'junk'])).toEqual([{ item: hash, adjust: { x: 10, y: 0, z: 0, rx: 45, ry: 0, rz: 0, scale: 125 } }]);
    expect(cleanWorn(Array.from({ length: 20 }, (_, i) => ({ item: i.toString(16).padStart(64, '0') })))).toHaveLength(16);
    expect(cleanOutfits([{ id, name: 'Day', items: [{ item: hash }], updatedAt: 't' }, { id, name: 3 }])).toEqual([{ id, name: 'Day', items: [{ item: hash }], updatedAt: 't' }]);
  });

  it('keeps only gallery entries whose licence reads (S5.06)', () => {
    const id = '00000000-0000-4000-8000-0000000000cc';
    const entry = { id, kind: 'item', name: 'Tee', authors: ['Maker', 7], licence: STRICT_LICENCE, slot: 'top', fits: ['neutral'], rank: null, takes: 3, publishedAt: 't', publisher: 'maker', manifest: 'c'.repeat(64), mine: false, taken: true };
    expect(cleanGallery([entry, { ...entry, licence: { ...STRICT_LICENCE, creditNotation: 'maybe' } }, { ...entry, kind: 'effect' }, { ...entry, manifest: 'x' }])).toEqual([{ ...entry, authors: ['Maker'] }]);
  });

  it('uploads to the slot the core gives, follows only the core’s own links, and takes files only within their size', async () => {
    const calls: string[] = [];
    let slot = 'https://core.example.org/api/v1/avatars/x/source?e=1&s=sig';
    const fetchFake: Fetch = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const path = new URL(url).pathname;
      if (path === '/api/v1/avatars' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'x', upload: { url: slot, method: 'PUT' } }), { status: 201 });
      if (path.endsWith('/source')) return new Response(JSON.stringify({ status: 'converting' }), { status: 202 });
      if (path.startsWith('/api/v1/files/')) return new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': path.includes('big') ? String(200 * 1024 * 1024) : '10' } });
      return new Response('{}', { status: 404 });
    };
    const api = new CoreApi(coreBase('https://core.example.org')!, fetchFake);
    const s = await api.avatarSlot('tok', { name: 'M', bytes: 30, sha256: 'b'.repeat(64) });
    await api.sendUpload(s.url, new Uint8Array(30));
    expect(calls).toEqual(['POST https://core.example.org/api/v1/avatars', `PUT ${slot}`]);
    slot = 'https://evil.example.com/steal';
    await expect(api.avatarSlot('tok', { name: 'M', bytes: 30, sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'bad-answer' });
    expect((await api.file('https://core.example.org/api/v1/files/ok')).length).toBe(10);
    await expect(api.file('https://core.example.org/api/v1/files/big')).rejects.toMatchObject({ code: 'too-large' });
    await expect(api.file('https://elsewhere.example.org/api/v1/files/ok')).rejects.toMatchObject({ code: 'bad-answer' });
  });
});

describe('the world browser on the client side', () => {
  it('keeps only well-formed worlds, with their counts', () => {
    expect(
      cleanWorlds([
        { id: '00000000-0000-4000-8000-0000000000AA', name: 'Plaza', online: true, players: 3, recommended: 4, capacity: 6 },
        { id: 'not-an-id', name: 'Bad' },
        { id: '00000000-0000-4000-8000-000000000002', name: 'N'.repeat(80), online: 'yes', players: -1, recommended: 2.5, capacity: 9 },
        null,
      ]),
    ).toEqual([
      { id: '00000000-0000-4000-8000-0000000000aa', name: 'Plaza', online: true, players: 3, recommended: 4, capacity: 6 },
      { id: '00000000-0000-4000-8000-000000000002', name: 'N'.repeat(48), online: false, players: 0, recommended: 0, capacity: 9 },
    ]);
    expect(cleanWorlds('junk')).toEqual([]);
  });

  it('marks favourites with PUT and DELETE, and finds a world by its id', async () => {
    const calls: string[] = [];
    const fetchFake: Fetch = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', name: 'Hidden', online: true, players: 1, recommended: 5, capacity: 10 }), { status: 200 });
    };
    const api = new CoreApi(coreBase('https://core.example.org')!, fetchFake);
    await api.setFavourite('a', '00000000-0000-4000-8000-000000000001', true);
    await api.setFavourite('a', '00000000-0000-4000-8000-000000000001', false);
    expect(await api.world('00000000-0000-4000-8000-000000000001')).toMatchObject({ name: 'Hidden', players: 1 });
    await expect(api.world('../me')).rejects.toBeInstanceOf(CoreError);
    expect(calls).toEqual([
      'PUT /api/v1/me/favourites/00000000-0000-4000-8000-000000000001',
      'DELETE /api/v1/me/favourites/00000000-0000-4000-8000-000000000001',
      'GET /api/v1/worlds/00000000-0000-4000-8000-000000000001',
    ]);
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

describe('offline mode (S2.13)', () => {
  it('lists the built-in worlds by their names, then the folders it was given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcoffline-'));
    try {
      for (const [kit, name] of [['park', 'The Park'], ['plaza', 'The Plaza']] as const) {
        mkdirSync(join(dir, kit));
        writeFileSync(join(dir, kit, 'world.json'), JSON.stringify({ manifest: { name } }));
      }
      mkdirSync(join(dir, 'broken'));
      expect(listOffline(dir, ['/home/someone/worlds/my-cabin'])).toEqual([
        { id: 'kit:park', name: 'The Park' },
        { id: 'kit:plaza', name: 'The Plaza' },
        { id: 'folder:0', name: 'my-cabin' },
      ]);
      expect(listOffline(join(dir, 'missing'), [])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

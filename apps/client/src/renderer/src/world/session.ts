// SPDX-License-Identifier: MPL-2.0
// Being in a world (S1.07–S1.11): the connection, the player's own movement (packages/sim, sent 20
// times a second and corrected by the server), everyone else drawn smoothly in the past, the
// camera, text chat and proximity voice. The page shows `state` and calls the methods; the
// browser's input events come in through `attach`.
import { type Collider, decodeColliders } from '@flatchat/content';
import { decodeCellBlock, type Message, type MessageOf, toHex } from '@flatchat/protocol';
import { BODY, type MoveInput, type WorldMap } from '@flatchat/sim';
import * as THREE from 'three/webgpu';
import type { Settings } from '../../../shared/settings';
import { JoinRefused, WorldConnection } from '../net/connection';
import { VoiceChain } from '../voice/chain';
import { cameraPose } from './camera';
import { Controls } from './controls';
import { type AvatarPose, canvasTag, CrowdView } from './crowd-view';
import { Downloader, type Progress } from './download';
import { type Body, loadPhysics, Physics } from './physics';
import { buildWorldScene } from './plaza-scene';
import { Remotes } from './remotes';
import { loadScene } from './scene-loader';

const CELL = 32;
const POSE_MS = 50;
const CHAT_KEEP = 100;
const CHAT_BURST = 5;
const CHAT_EVERY_MS = 1500;
export const CHAT_MAX = 280;

export interface ChatLine {
  id: number;
  /** The speaker's display name; empty for the world's own notices. */
  from: string;
  text: string;
  /** A notice the page words itself: someone arrived or left. */
  notice?: 'joined' | 'left';
}

export type VoiceStatus = 'off' | 'starting' | 'on' | 'denied';

export interface WorldState {
  status: 'connecting' | 'joined' | 'lost' | 'refused';
  /** Why it was lost or refused: a refusal or leave reason, or a network one. */
  reason: string;
  detail: string;
  players: number;
  rttMs: number;
  fps: number;
  backend: string;
  locked: boolean;
  chat: ChatLine[];
  voice: VoiceStatus;
  /** The microphone is sending right now. */
  talking: boolean;
  muted: boolean;
  person: 'first' | 'third';
  /** While the world's content downloads (S2.04). */
  download: Progress | undefined;
  /** The built world's name, once it has loaded. */
  world: string;
}

/** A map made in code as colliders (boxes), for the physics. */
export function mapColliders(map: WorldMap): Collider[] {
  return map.solids.map((s) => ({
    type: 'box',
    position: [(s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2],
    rotation: [0, 0, 0, 1],
    half: [(s.max.x - s.min.x) / 2, (s.max.y - s.min.y) / 2, (s.max.z - s.min.z) / 2],
  }));
}

export interface Ticket {
  address: string;
  token: Uint8Array;
  iceServers?: RTCIceServer[];
}

export class WorldSession {
  readonly state: WorldState;
  private readonly canvas: HTMLCanvasElement;
  private readonly map: WorldMap;
  private settings: Settings;
  private readonly controls: Controls;
  private readonly remotes = new Remotes();
  private readonly names = new Map<number, string>();
  private renderer: THREE.WebGPURenderer | undefined;
  private crowd: CrowdView | undefined;
  private conn: WorldConnection | undefined;
  private chain: VoiceChain | undefined;
  private volume: GainNode | undefined;
  private mic: MediaStream | undefined;
  private physics: Physics | undefined;
  private me: Body = { x: 0, y: 0, z: 0, vy: 0, grounded: true };
  private downloader: Downloader | undefined;
  private announced: { hash: string; size: number } | undefined;
  private mapMeshes: THREE.Object3D[] = [];
  private scene: THREE.Scene | undefined;
  private entity = -1;
  private seq = 0;
  private pingId = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private detachers: Array<() => void> = [];
  private lastFrame = 0;
  private frames = 0;
  private fpsAt = 0;
  private chatId = 0;
  private chatTokens = CHAT_BURST;
  private chatAt = performance.now();
  private rosterSeen = false;
  private closed = false;
  /** Set while the page's chat box has focus: keys go to the text, not the avatar. */
  typing = false;

  constructor(canvas: HTMLCanvasElement, map: WorldMap, settings: Settings, onChange: (state: WorldState) => WorldState = (s) => s) {
    this.canvas = canvas;
    this.map = map;
    this.settings = settings;
    this.controls = new Controls(settings.keys, settings.view.sensitivity, settings.view.invertY);
    this.state = onChange({
      status: 'connecting',
      reason: '',
      detail: '',
      players: 0,
      rttMs: 0,
      fps: 0,
      backend: '',
      locked: false,
      chat: [],
      voice: 'off',
      talking: false,
      muted: settings.voice.muted,
      person: settings.view.person,
      download: undefined,
      world: '',
    });
  }

  /** Draws the world, then joins; resolves once joined, or with the state saying why not. */
  async start(ticket: Ticket): Promise<void> {
    const view = buildWorldScene(this.map);
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    await renderer.init();
    this.renderer = renderer;
    this.state.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const resize = (): void => {
      const w = Math.max(1, this.canvas.clientWidth);
      const h = Math.max(1, this.canvas.clientHeight);
      renderer.setSize(w, h, false);
      view.camera.aspect = w / h;
      view.camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    this.detachers.push(() => window.removeEventListener('resize', resize));
    this.crowd = new CrowdView(canvasTag);
    view.scene.add(this.crowd.group);
    this.scene = view.scene;
    this.mapMeshes = view.scene.children.filter((o) => o.name.startsWith('surface:'));
    await loadPhysics();
    this.me = { x: this.map.spawn.x, y: this.map.spawn.y, z: this.map.spawn.z, vy: 0, grounded: true };
    this.controls.yaw = this.map.spawn.yaw;
    this.lastFrame = performance.now();
    this.fpsAt = this.lastFrame;
    await renderer.setAnimationLoop(() => this.frame(view.scene, view.camera));

    try {
      this.conn = await WorldConnection.join({ signalUrl: ticket.address, token: ticket.token, iceServers: ticket.iceServers ?? [], onMessage: (m) => this.message(m) });
    } catch (err) {
      this.state.status = err instanceof JoinRefused ? 'refused' : 'lost';
      this.state.reason = err instanceof JoinRefused ? err.reason : 'unreachable';
      this.state.detail = err instanceof JoinRefused ? err.detail : '';
      return;
    }
    this.entity = this.conn.entity;
    const spawn = this.conn.spawn!;
    this.me = { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z, vy: 0, grounded: true };
    this.controls.yaw = spawn.yaw;
    if (this.announced) {
      // A built world (S2.04): its content first; the code-made plaza is not this world.
      for (const m of this.mapMeshes) m.visible = false;
      try {
        await this.loadWorld(this.announced.hash, this.announced.size);
      } catch (err) {
        this.state.status = 'lost';
        this.state.reason = 'download';
        this.state.detail = err instanceof Error ? err.message.slice(0, 160) : '';
        this.conn.close('download failed');
        return;
      }
    } else {
      this.physics = new Physics(mapColliders(this.map), this.me);
      this.cameraSolids = this.map.solids;
    }
    this.physics!.teleport(this.me.x, this.me.y, this.me.z);
    this.state.status = 'joined';
    this.conn.onClose((reason) => {
      if (this.closed || this.state.status !== 'joined') return;
      this.state.status = 'lost';
      this.state.reason = reason;
    });
    this.timers.push(setInterval(() => this.sendPose(), POSE_MS));
    this.timers.push(setInterval(() => this.conn?.send({ type: 'ping', id: (this.pingId = (this.pingId + 1) & 0xffff), time: Math.floor(performance.now()) >>> 0 }), 2000));
  }

  /** The browser's input: keys, mouse buttons, mouse look and pointer lock. */
  attach(): void {
    const keydown = (e: KeyboardEvent): void => {
      if (this.typing) return;
      const action = this.controls.press(e.code);
      if (action && action !== 'menu') e.preventDefault();
    };
    const keyup = (e: KeyboardEvent): void => this.controls.release(e.code);
    const mousedown = (e: MouseEvent): void => {
      if (document.pointerLockElement === this.canvas) this.controls.press(`Mouse${e.button}`);
    };
    const mouseup = (e: MouseEvent): void => this.controls.release(`Mouse${e.button}`);
    const mousemove = (e: MouseEvent): void => {
      if (document.pointerLockElement === this.canvas) this.controls.look(e.movementX, e.movementY);
    };
    const lockchange = (): void => {
      this.state.locked = document.pointerLockElement === this.canvas;
      if (!this.state.locked) this.controls.clear();
    };
    const blur = (): void => this.controls.clear();
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('mousedown', mousedown);
    window.addEventListener('mouseup', mouseup);
    window.addEventListener('mousemove', mousemove);
    window.addEventListener('blur', blur);
    document.addEventListener('pointerlockchange', lockchange);
    this.detachers.push(() => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('mousedown', mousedown);
      window.removeEventListener('mouseup', mouseup);
      window.removeEventListener('mousemove', mousemove);
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerlockchange', lockchange);
    });
  }

  /** Mouse look needs the pointer; a click on the world asks for it. */
  lock(): void {
    void this.canvas.requestPointerLock();
  }

  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Actions the page handles (chat, menu, mute, view); polled once per frame by the page. */
  took(action: 'chat' | 'menu'): boolean {
    return this.controls.took(action);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.controls.keys = s.keys;
    this.controls.sensitivity = s.view.sensitivity;
    this.controls.invertY = s.view.invertY;
    this.state.person = s.view.person;
    if (this.volume) this.volume.gain.value = s.voice.volume;
  }

  /** Sends a chat line; false when it would go over the limit (the server would drop it). */
  say(text: string): boolean {
    const line = text.trim().slice(0, CHAT_MAX);
    if (!line || !this.conn) return true;
    const now = performance.now();
    this.chatTokens = Math.min(CHAT_BURST, this.chatTokens + (now - this.chatAt) / CHAT_EVERY_MS);
    this.chatAt = now;
    if (this.chatTokens < 1) return false;
    this.chatTokens -= 1;
    this.conn.send({ type: 'say', text: line });
    return true;
  }

  // ----------------------------------------------------------------------------- voice

  /** Starts the voice chain: hearing always; speaking when a microphone is allowed (S1.11). */
  async startVoice(): Promise<void> {
    if (this.chain || this.state.voice === 'starting') return;
    this.state.voice = 'starting';
    try {
      this.chain = await VoiceChain.create();
      await this.chain.ctx.resume();
      this.volume = new GainNode(this.chain.ctx, { gain: this.settings.voice.volume });
      this.chain.output.connect(this.volume).connect(this.chain.ctx.destination);
    } catch {
      this.state.voice = 'off';
      return;
    }
    try {
      const device = this.settings.voice.inputDevice;
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(device ? { deviceId: { exact: device } } : {}) },
      });
      const source = this.chain.ctx.createMediaStreamSource(this.mic);
      this.chain.muted = true;
      await this.chain.startSending(source, (f) => this.conn?.send({ type: 'voice', ...f }));
      this.state.voice = 'on';
    } catch {
      // No microphone, or it was refused: the player still hears everyone.
      this.state.voice = 'denied';
    }
  }

  toggleMute(): void {
    this.state.muted = !this.state.muted;
  }

  // ------------------------------------------------------------------------------ loops

  private frame(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.typing) {
      if (this.controls.took('view')) this.state.person = this.state.person === 'first' ? 'third' : 'first';
      if (this.controls.took('mute')) this.toggleMute();
    }
    if (this.state.status === 'joined' && this.physics) {
      const axes = this.typing ? { forward: 0, right: 0 } : this.controls.axes();
      const input: MoveInput = { ...axes, run: !this.typing && this.controls.held('run'), jump: !this.typing && this.controls.held('jump'), yaw: this.controls.yaw };
      this.me = this.physics.step(input, dt);
    }
    if (this.chain) {
      const push = this.settings.voice.mode === 'push';
      this.chain.muted = this.state.muted || (push && (this.typing || !this.controls.held('talk')));
      this.state.talking = this.chain.sending;
      this.placeVoices();
    }
    const pose = cameraPose(this.state.person, this.me, this.controls.yaw, this.controls.pitch, this.cameraSolids);
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    this.crowd?.update(this.avatars(now), camera.position);
    this.renderer?.render(scene, camera);
    this.frames += 1;
    if (now - this.fpsAt >= 500) {
      this.state.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      this.frames = 0;
      this.fpsAt = now;
      this.remotes.prune(now - 5000);
    }
  }

  private avatars(now: number): AvatarPose[] {
    const list: AvatarPose[] = [];
    const myLevel = this.state.talking ? 0.6 : 0;
    list.push({ entity: this.entity, x: this.me.x, y: this.me.y, z: this.me.z, yaw: this.controls.yaw, name: '', speaking: myLevel, hidden: this.state.person === 'first' || this.state.status !== 'joined' });
    for (const entity of this.remotes.entities()) {
      const p = this.remotes.at(entity, now);
      if (!p) continue;
      list.push({ entity, ...p, name: this.names.get(entity) ?? '', speaking: (this.chain?.mouthOf(entity)?.level ?? 0) / 15 });
    }
    return list;
  }

  private placeVoices(): void {
    if (!this.chain) return;
    const now = performance.now();
    const speakers = new Map<number, { x: number; y: number; z: number }>();
    for (const entity of this.remotes.entities()) {
      const p = this.remotes.at(entity, now);
      if (p) speakers.set(entity, { x: p.x, y: p.y + BODY.eye, z: p.z });
    }
    this.chain.place({ x: this.me.x, y: this.me.y + BODY.eye, z: this.me.z }, this.controls.yaw, speakers);
  }

  private sendPose(): void {
    if (!this.conn || this.state.status !== 'joined') return;
    this.seq = (this.seq + 1) & 0xffff;
    const m = this.me;
    const stance = m.grounded ? 'standing' : m.vy > 0 ? 'jumping' : 'falling';
    this.conn.send({ type: 'pose', seq: this.seq, position: { x: m.x, y: m.y, z: m.z }, yaw: this.controls.yaw, look: this.controls.pitch, stance });
  }

  private message(m: Message): void {
    if (this.downloader?.message(m)) return;
    switch (m.type) {
      case 'content':
        this.announced = { hash: toHex(m.world), size: m.size };
        break;
      case 'welcome':
        // Before the join's first snapshot, so the player is never drawn as someone else.
        this.entity = m.entity;
        break;
      case 'snapshot':
        this.snapshot(m);
        break;
      case 'roster':
        this.roster(m);
        break;
      case 'chat':
        this.chatLine({ from: m.from === undefined ? '' : (this.names.get(m.from) ?? '?'), text: m.text });
        break;
      case 'voiceBundle':
        this.chain?.receive(m);
        break;
      case 'pong':
        this.state.rttMs = (Math.floor(performance.now()) >>> 0) - m.time;
        break;
      case 'leave':
        this.state.status = 'lost';
        this.state.reason = m.reason;
        this.state.detail = m.detail;
        break;
      default:
        break;
    }
  }

  private snapshot(s: MessageOf<'snapshot'>): void {
    // A refused move: back to where the server has the player.
    if (s.correction && s.correction.seq !== 0) {
      this.me = { x: s.correction.position.x, y: s.correction.position.y, z: s.correction.position.z, vy: 0, grounded: true };
      this.physics?.teleport(this.me.x, this.me.y, this.me.z);
    }
    const now = performance.now();
    for (const bytes of s.blocks) {
      const block = decodeCellBlock(bytes);
      for (const e of block.full) {
        if (e.id !== this.entity) this.remotes.push(e.id, now, { x: block.cx * CELL + e.x, y: e.y, z: block.cz * CELL + e.z, yaw: e.yaw });
      }
      for (const e of block.coarse) {
        if (e.id !== this.entity) this.remotes.push(e.id, now, { x: block.cx * CELL + e.x, y: e.y, z: block.cz * CELL + e.z, yaw: e.yaw });
      }
    }
  }

  private roster(r: MessageOf<'roster'>): void {
    if (r.full) this.names.clear();
    for (const p of r.players) {
      this.names.set(p.entity, p.name);
      if (this.rosterSeen && p.entity !== this.entity) this.chatLine({ from: '', text: p.name, notice: 'joined' });
    }
    for (const id of r.left) {
      const name = this.names.get(id);
      if (name !== undefined && id !== this.entity) this.chatLine({ from: '', text: name, notice: 'left' });
      this.names.delete(id);
      this.remotes.forget(id);
    }
    this.rosterSeen = true;
    this.state.players = this.names.size;
  }

  private chatLine(line: Omit<ChatLine, 'id'>): void {
    this.state.chat.push({ id: (this.chatId += 1), ...line });
    if (this.state.chat.length > CHAT_KEEP) this.state.chat.splice(0, this.state.chat.length - CHAT_KEEP);
  }

  /** Solids the third-person camera stays out of: the code-made map's boxes (a built world's
   *  camera uses its colliders' bounds, which the physics already has). */
  private cameraSolids: ReadonlyArray<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }> = [];

  /** Downloads a built world, then builds its scenes and its solids (S2.04). */
  private async loadWorld(hash: string, size: number): Promise<void> {
    const bridge = window.flatchat;
    if (!bridge || !this.conn) throw new Error('no bridge');
    const conn = this.conn;
    this.downloader = new Downloader((m) => conn.send(m), { has: (h) => bridge.contentHas(h), get: (h) => bridge.contentGet(h), put: (h, b) => bridge.contentPut(h, b) }, (p) => {
      this.state.download = { ...p };
    });
    this.state.download = { done: 0, total: size };
    const { world, files } = await this.downloader.world(hash, size);
    const colliders = decodeColliders(files.get(world.collision)!);
    this.physics = new Physics(colliders, this.me);
    for (const scene of world.scenes) {
      const group = await loadScene(this.renderer!, files.get(scene.glb)!);
      this.scene?.add(group);
    }
    this.cameraSolids = colliders.filter((c) => c.type === 'box').map((c) => ({
      min: { x: c.position[0] - c.half[0], y: c.position[1] - c.half[1], z: c.position[2] - c.half[2] },
      max: { x: c.position[0] + c.half[0], y: c.position[1] + c.half[1], z: c.position[2] + c.half[2] },
    }));
    this.state.world = world.manifest.name;
    this.state.download = undefined;
  }

  /** Leaves the world and lets go of the renderer, the microphone and the loops. */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const d of this.detachers) d();
    this.detachers = [];
    this.unlock();
    this.downloader?.cancel();
    this.conn?.close('left the world');
    this.physics?.dispose();
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.chain?.close();
    void this.renderer?.setAnimationLoop(null);
    this.renderer?.dispose();
  }
}

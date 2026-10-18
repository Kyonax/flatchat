// SPDX-License-Identifier: MPL-2.0
// Being in a world (S1.07–S1.11): the connection, the player's own movement (packages/sim, sent 20
// times a second and corrected by the server), everyone else drawn smoothly in the past, the
// camera, text chat and proximity voice. The page shows `state` and calls the methods; the
// browser's input events come in through `attach`.
//
// The full movement set (S2.06): flying where the world allows it (F; Space up, C down); sitting
// on a seat within reach (E; any move stands up); walking to the spot under the crosshair (G: along
// the world's navigation mesh, or straight on a map made in code) or teleporting there (H: the
// world checks it and answers `placed`). Heights (S2.07): the player's chosen height goes in the
// hello and in `appearance`; everyone is drawn, and the camera placed, at the height the world
// fitted (the roster's).
import { type Collider, decodeColliders, DEFAULT_LOOK, type WorldLook } from '@flatchat/content';
import { decodeCellBlock, fromHex, type Message, type MessageOf, toHex } from '@flatchat/protocol';
import { BODY, type MoveInput, type WorldMap } from '@flatchat/sim';
import * as THREE from 'three/webgpu';
import type { Settings } from '../../../shared/settings';
import { JoinRefused, WorldConnection } from '../net/connection';
import { VoiceChain } from '../voice/chain';
import { cameraPose } from './camera';
import { Controls } from './controls';
import { AvatarLayer, type AvatarState, type Worn } from './avatar-layer';
import { FrameTuner, type MeasuredTier, tierOf, viewerPolicy } from './avatar-policy';
import type { Expression, HandPose } from './avatar-pose';
import { type AvatarPose, canvasTag, CrowdView } from './crowd-view';
import { Downloader, type Progress } from './download';
import { Navigation } from './navigation';
import { type Person, type Role, sortPeople } from './people';
import { buildReport, type ReportDraft, type ReportEvidence, type ReportPayload } from './report';
import { ClipRecorder } from '../voice/clip';
import { buildParts } from './parts';
import { type Body, loadPhysics, Physics } from './physics';
import { buildWorldScene } from './plaza-scene';
import { Remotes } from './remotes';
import { loadScene } from './scene-loader';
import { builtInEmote } from './clips';
import { EffectsLayer, type EffectStats } from './effects';
import { gpuResets, loseGpu, watchGpu } from './gpu-reset';
import { applyLook, LookPipeline, lookEffects } from './look';
import { OverlayLayer, type ShownOverlay } from './overlays';
import { EmoteSounds } from './emote-sounds';
import { setUiVolume, Strides, uiSound, WorldSounds } from './sounds';
import { PathWalker } from './walker';

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
  /** When it arrived (wall clock, ms), for a report's chat excerpt. */
  at: number;
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
  /** Avatars drawn at each level (S4.05), refreshed twice a second. */
  avatars: { lod0: number; lod1: number; lod2: number; impostor: number };
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
  flying: boolean;
  /** How many of the world's sound emitters play (S2.14), and footsteps have sounded (P.06). */
  sounds: number;
  footsteps: number;
  /** How many base library parts the world placed (S2.05). */
  parts: number;
  /** A short notice the page words in its language ('' for none). */
  notice: '' | 'noFlying' | 'noSeat' | 'teleportRefused' | 'nothingThere';
  /** Everyone here with their roles (S3.06), this player first. */
  people: Person[];
  /** This player's role here. */
  role: Role;
  /** A moderator muted this player (S3.07): the reason, or undefined when not muted. */
  heldMute: string | undefined;
  /** This player's expression (S4.07), for the HUD. */
  expression: Expression;
  /** The tier the first visit measured (S4.05), once it has: the page keeps it in the settings. */
  measuredTier: MeasuredTier | undefined;
  /** The accounts this player muted, in every world (S3.08). */
  silenced: string[];
  /** Earmuffs on: far voices drop to a murmur (S3.08). */
  earmuffs: boolean;
  /** Entities the world keeps apart from this player by a block either way (S3.11): not drawn,
   *  not heard, not read. */
  hidden: number[];
  /** Friends and requests both ways, and the accounts this player blocked (S3.10, S3.11). */
  friends: string[];
  incoming: string[];
  outgoing: string[];
  blocked: string[];
  /** This account is under 18 (S3.10): its client keeps a minor's defaults too. */
  minor: boolean;
  /** What this player wears (S5.05): what it asked for, then what the world fitted. */
  outfit: Worn[];
  /** Items drawn on avatars now, everyone's together (S5.05). */
  dressed: number;
  /** The emote or dance this player plays (its manifest), '' for none (S5.07); and whether the
   *  avatar shows it in this frame. */
  emote: string;
  emoting: boolean;
  /** Emote and dance sounds playing near the viewer (S5.07). */
  emoteSounds: number;
  /** Effects (S6.01): playing, their particles, refused, stopped by the guard, drawn with the
   *  scene's depth, the runtime's backend, and whether it could not start. */
  effects: EffectStats;
  /** Screen overlays showing now (S6.02), and safe mode: the safe-mode key's state. */
  overlays: ShownOverlay[];
  safeMode: boolean;
  /** Avatars drawing their creator shaders now (S6.03), and whether the GPU was reset under this
   *  view (the page then joins again, with creator shaders off for the session). */
  shaders: number;
  gpuReset: boolean;
  /** GPU resets in this run of the client (creator shaders stay off after one). */
  gpuResets: number;
  /** The world's screen effects drawn now (S6.05): what it asks for and the viewer allows. */
  look: { bloom: boolean; shafts: boolean; reflections: boolean; filters: boolean };
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
  /** The spawn group a portal named (S2.11). */
  spawn?: string;
  /** Only through a TURN relay (the client's --relay-only, S2.12). */
  relayOnly?: boolean;
  /** An offline world in the client's own main process (S2.13). */
  local?: boolean;
}

/** Where a portal leads (S2.11). */
export interface Travel {
  world: string;
  spawn: string;
}

export class WorldSession {
  readonly state: WorldState;
  private readonly canvas: HTMLCanvasElement;
  private readonly map: WorldMap;
  private settings: Settings;
  private readonly controls: Controls;
  private readonly remotes = new Remotes();
  private readonly names = new Map<number, string>();
  private readonly people = new Map<number, Person>();
  /** Everyone seen during this visit, by entity, gone or not: a report names the speakers. */
  private readonly everyone = new Map<number, { account: string; name: string }>();
  /** What this client heard lately, for a report's clip (S3.02); nothing reads it but a report. */
  private readonly recorder = new ClipRecorder();
  private worldId = '';
  private joinedWall = 0;
  private renderer: THREE.WebGPURenderer | undefined;
  private crowd: CrowdView | undefined;
  /** Players' own avatars (S4.05), over the placeholders. */
  private avatarLayer: AvatarLayer | undefined;
  private effects: EffectsLayer | undefined;
  /** Screen overlays (S6.02): worn ones and the world's, by the viewer's consent. */
  private overlays: OverlayLayer | undefined;
  /** The world's look (S6.05), its sun, and its screen effects' pipeline with what it was built for. */
  private look: WorldLook = DEFAULT_LOOK;
  private sun: THREE.DirectionalLight | undefined;
  private lookPipeline: LookPipeline | undefined;
  private lookKey = '';
  /** Each player's worn avatar (its manifest's hash) and face (S4.07), from the roster. */
  private readonly worn = new Map<number, string>();
  private readonly faces = new Map<number, { expression: Expression; left: HandPose; right: HandPose }>();
  /** Each player's trust level, from the roster: the viewer's shield reads it (S4.09). */
  private readonly trusts = new Map<number, number>();
  private readonly tuner = new FrameTuner();
  /** The first visit's measurement (S4.05): frames from the third second to the fifteenth. */
  private bench: { from: number; samples: number[] } | undefined;
  private policyAt = 0;
  /** This player's own face, as sent. */
  private face: { expression: Expression; left: HandPose; right: HandPose } = { expression: 'neutral', left: 'relaxed', right: 'relaxed' };
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
  /** What this player wants to wear and when the last change went: the world takes one a second
   *  (S5.05), so a quicker toggle waits and goes as the latest. */
  private wantOutfit: Worn[] | undefined;
  private outfitSentAt = -Infinity;
  private outfitTimer: ReturnType<typeof setTimeout> | undefined;
  private outfitRestored = false;
  /** Each player's emote or dance (S5.07): the animation and the world tick it started at. */
  private readonly emotes = new Map<number, { anim: string; tick: number }>();
  /** The world's clock: the last snapshot's tick and when it came, and the tick rate. */
  private serverTick = 0;
  private serverTickAt = 0;
  private emoteSentAt = -Infinity;
  private emoteSounds: EmoteSounds | undefined;
  private emoteTimer: ReturnType<typeof setTimeout> | undefined;
  private wantEmote: string | undefined | null = null;
  private closed = false;
  /** Set while the page's chat box has focus: keys go to the text, not the avatar. */
  typing = false;
  /** Called when the player walks into a portal (S2.11): the page takes them there. */
  onTravel: ((to: Travel) => void) | undefined;
  // The movement set (S2.06) and heights (S2.07).
  private camera: THREE.PerspectiveCamera | undefined;
  private navigation: Navigation | undefined;
  private walker: PathWalker | undefined;
  private seats: Array<{ x: number; y: number; z: number; yaw: number }> = [];
  private pickables: THREE.Object3D[] = [];
  private readonly ray = new THREE.Raycaster();
  private canFly = false;
  private sitting = false;
  private readonly heights = new Map<number, number>();
  private readonly stances = new Map<number, string>();
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // Sounds (S2.14).
  private sounds: WorldSounds | undefined;
  private readonly myStrides = new Strides();
  private readonly strides = new Map<number, Strides>();

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
      avatars: { lod0: 0, lod1: 0, lod2: 0, impostor: 0 },
      backend: '',
      locked: false,
      chat: [],
      voice: 'off',
      talking: false,
      muted: settings.voice.muted,
      person: settings.view.person,
      download: undefined,
      world: '',
      flying: false,
      sounds: 0,
      footsteps: 0,
      parts: 0,
      notice: '',
      people: [],
      role: 'visitor',
      heldMute: undefined,
      expression: 'neutral',
      measuredTier: undefined,
      silenced: [],
      earmuffs: false,
      hidden: [],
      friends: [],
      incoming: [],
      outgoing: [],
      blocked: [],
      minor: false,
      outfit: [],
      dressed: 0,
      emote: '',
      emoting: false,
      emoteSounds: 0,
      effects: { playing: 0, world: 0, instances: 0, refused: 0, refusedWhy: '', stopped: 0, depth: false, backend: '', failed: false },
      overlays: [],
      safeMode: false,
      shaders: 0,
      gpuReset: false,
      gpuResets: gpuResets.count,
      look: { bloom: false, shafts: false, reflections: false, filters: false },
    });
  }

  /** Draws the world, then joins; resolves once joined, or with the state saying why not. */
  async start(ticket: Ticket): Promise<void> {
    const view = buildWorldScene(this.map);
    // Opaque: effects blend over the finished image, and their alpha must not show the page through.
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    await renderer.init();
    this.renderer = renderer;
    // A GPU reset (S6.03, T-01): creator shaders off for the session; the page joins again.
    this.detachers.push(
      watchGpu(renderer, this.canvas, () => {
        this.state.gpuReset = true;
      }),
    );
    if (window.flatchat?.e2e) (window as unknown as { flatchatTest?: { loseGpu(): void } }).flatchatTest = { loseGpu: () => loseGpu(renderer) };
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
    // Avatars come from the core (S4.05): an offline world has none, and keeps the placeholders.
    const bridge = window.flatchat;
    if (bridge?.avatarFile) {
      this.avatarLayer = new AvatarLayer(
        renderer,
        async (manifest, level) => {
          const r = await bridge.avatarFile(manifest, level);
          if (!r.ok) throw new Error(r.error);
          return { bytes: r.bytes, manifest: r.manifest, ...(r.kit ? { kit: r.kit } : {}) };
        },
        bridge.itemFile
          ? async (manifest, part) => {
              const r = await bridge.itemFile(manifest, part);
              if (!r.ok) throw new Error(r.error);
              return { manifest: r.manifest, ...(r.bytes ? { bytes: r.bytes } : {}) };
            }
          : undefined,
        bridge.animationFile
          ? async (manifest) => {
              const r = await bridge.animationFile(manifest, 'vrma');
              if (!r.ok) throw new Error(r.error);
              return { manifest: r.manifest, bytes: r.bytes };
            }
          : undefined,
      );
      view.scene.add(this.avatarLayer.group);
      this.detachers.push(() => this.avatarLayer?.dispose());
      // Effects (S6.01): worn ones ride their markers; the runtime loads with the first.
      const itemFile = bridge.itemFile;
      if (itemFile) {
        this.effects = new EffectsLayer(renderer, async (item) => {
          const r = await itemFile(item, 'effect');
          if (!r.ok || !r.bytes) throw new Error(r.ok ? 'no effect bundle' : r.error);
          return new Uint8Array(r.bytes);
        });
        this.avatarLayer.effects = this.effects;
        this.detachers.push(() => this.effects?.dispose());
      }
    }
    // Screen overlays (S6.02): the core's items when signed in, a world's own in any world.
    const itemFile = bridge?.itemFile;
    this.overlays = new OverlayLayer(
      this.settings.overlays,
      itemFile
        ? async (manifest, part) => {
            const r = await itemFile(manifest, part);
            if (!r.ok) throw new Error(r.error);
            return { manifest: r.manifest, ...(r.bytes ? { bytes: r.bytes } : {}) };
          }
        : undefined,
      (shown) => {
        this.state.overlays = shown;
      },
    );
    this.scene = view.scene;
    this.mapMeshes = view.scene.children.filter((o) => o.name.startsWith('surface:'));
    await loadPhysics();
    this.me = { x: this.map.spawn.x, y: this.map.spawn.y, z: this.map.spawn.z, vy: 0, grounded: true };
    this.controls.yaw = this.map.spawn.yaw;
    this.lastFrame = performance.now();
    this.fpsAt = this.lastFrame;
    this.camera = view.camera;
    try {
      this.sounds = new WorldSounds(this.settings.sound.world);
      // Emotes' and dances' sounds (S5.07), on the world's audio, at the viewer's own volume.
      const animationFile = bridge?.animationFile;
      if (animationFile) {
        this.emoteSounds = new EmoteSounds(this.sounds.ctx, this.settings.sound.emotes, async (anim) => {
          // The built-in gestures carry no sound.
          if (builtInEmote(anim)) return undefined;
          const r = await animationFile(anim, 'audio');
          return r.ok ? { bytes: r.bytes, loop: r.manifest.use === 'dance' } : undefined;
        });
      }
    } catch {
      // No audio output: a silent world.
    }
    setUiVolume(this.settings.sound.ui);
    await renderer.setAnimationLoop(() => this.frame(view.scene, view.camera));

    try {
      const height = Math.round(this.settings.avatar.height * 100);
      const proportions = percent(this.settings.avatar.proportions);
      this.conn = ticket.local
        ? await WorldConnection.joinLocal({ token: ticket.token, height, proportions, onMessage: (m) => this.message(m) })
        : await WorldConnection.join({
            signalUrl: ticket.address,
            token: ticket.token,
            iceServers: ticket.iceServers ?? [],
            ...(ticket.spawn ? { spawn: ticket.spawn } : {}),
            ...(ticket.relayOnly ? { relayOnly: true } : {}),
            height,
            proportions,
            onMessage: (m) => this.message(m),
          });
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
      this.canFly = this.map.flying;
      this.pickables = this.mapMeshes;
    }
    this.physics!.teleport(this.me.x, this.me.y, this.me.z);
    this.state.status = 'joined';
    // An outfit restored at the first roster waited for this (S5.05).
    this.flushOutfit();
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
    // Chromium's first movement after a lock can be the pointer's whole jump to where it was
    // locked: no hand moves that far in one event, so the camera does not swing round (the
    // end-to-end test's walk to the portal caught it).
    let lockedAt = 0;
    const mousemove = (e: MouseEvent): void => {
      if (document.pointerLockElement !== this.canvas) return;
      if (performance.now() - lockedAt < 100 || Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.controls.look(e.movementX, e.movementY);
    };
    const lockchange = (): void => {
      this.state.locked = document.pointerLockElement === this.canvas;
      if (this.state.locked) lockedAt = performance.now();
      else this.controls.clear();
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
    // A new height or new proportions go to the world, which fits them and tells everyone (S2.07, S4.10).
    const was = this.settings.avatar;
    const reshaped = JSON.stringify(s.avatar.proportions) !== JSON.stringify(was.proportions);
    if ((s.avatar.height !== was.height || reshaped) && this.state.status === 'joined') {
      this.conn?.send({ type: 'appearance', height: Math.round(s.avatar.height * 100), proportions: percent(s.avatar.proportions) });
    }
    this.settings = s;
    if (this.overlays) {
      this.overlays.settings = s.overlays;
      this.overlays.refresh();
    }
    this.controls.keys = s.keys;
    this.controls.sensitivity = s.view.sensitivity;
    this.controls.invertY = s.view.invertY;
    this.state.person = s.view.person;
    if (this.volume) this.volume.gain.value = s.voice.volume;
    if (this.emoteSounds) this.emoteSounds.volume = s.sound.emotes;
    if (this.sounds) this.sounds.volume = s.sound.world;
    setUiVolume(s.sound.ui);
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
      this.chain.recorder = this.recorder;
      this.chain.volumeOf = (entity) => this.settings.voice.volumes[this.people.get(entity)?.account ?? ''] ?? 1;
      this.chain.earmuffs = this.state.earmuffs;
      this.applySilenced();
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
      if (this.controls.took('earmuffs')) this.toggleEarmuffs();
      for (const e of ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const) if (this.controls.took(e)) this.setFace({ expression: this.face.expression === e ? 'neutral' : e });
      if (this.controls.took('hands')) this.setFace({ left: nextHand(this.face.left), right: nextHand(this.face.right) });
      if (this.state.status === 'joined') {
        if (this.controls.took('fly')) this.toggleFlying();
        if (this.controls.took('sit')) this.sitOrStand();
        if (this.controls.took('goto')) this.toSpot(false);
        if (this.controls.took('teleport')) this.toSpot(true);
      }
    }
    if (this.state.status === 'joined' && this.physics) {
      let axes = this.typing ? { forward: 0, right: 0 } : this.controls.axes();
      const keys = axes.forward !== 0 || axes.right !== 0;
      const jump = !this.typing && this.controls.held('jump');
      // A key takes over from a walk to a spot; any move stands a seated player up, and ends an
      // emote or a dance (S5.07).
      if (keys) this.walker = undefined;
      if ((keys || jump || this.walker) && this.state.emote && this.wantEmote !== undefined) this.playEmote(undefined);
      if (this.sitting && (keys || jump)) this.sitting = false;
      if (this.walker) {
        axes = this.walker.input(this.me, this.controls.yaw, dt);
        if (this.walker.done) this.walker = undefined;
      }
      if (!this.sitting) {
        const flying = this.physics.flying;
        const up = flying && !this.typing ? (jump ? 1 : 0) - (this.controls.held('down') ? 1 : 0) : 0;
        const input: MoveInput = { ...axes, run: !this.typing && this.controls.held('run'), jump: jump && !flying, yaw: this.controls.yaw };
        this.me = this.physics.step(input, dt, up);
      }
    }
    if (this.chain) {
      const push = this.settings.voice.mode === 'push';
      this.chain.muted = this.state.muted || this.state.heldMute !== undefined || (push && (this.typing || !this.controls.held('talk')));
      this.state.talking = this.chain.sending;
      this.placeVoices();
    }
    const pose = cameraPose(this.state.person, this.me, this.controls.yaw, this.controls.pitch, this.cameraSolids, this.scaleOf(this.entity) * (this.sitting ? 0.7 : 1));
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    if (this.sounds && this.state.status === 'joined') this.footsteps(now, pose.position);
    const poses = this.avatars(now);
    if (this.avatarLayer) this.tunePolicy(dt * 1000, now);
    const drawn = this.avatarLayer?.update(this.avatarStates(poses), camera, dt, now);
    if (drawn) for (const p of poses) if (drawn.has(p.entity)) p.avatarDrawn = true;
    this.crowd?.update(poses, camera.position);
    this.updateLook(scene, camera as THREE.PerspectiveCamera);
    if (this.lookPipeline) this.lookPipeline.render();
    else this.renderer?.render(scene, camera);
    this.effects?.frame(camera, dt, this.lookPipeline?.depth());
    this.frames += 1;
    if (now - this.fpsAt >= 500) {
      this.state.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      if (this.avatarLayer) {
        this.state.avatars = this.avatarLayer.counts();
        this.state.shaders = this.avatarLayer.shaderCount();
        this.state.gpuResets = gpuResets.count;
        this.state.dressed = this.avatarLayer.dressedItems();
        this.state.emoting = this.avatarLayer.emoting(this.entity);
        this.state.emoteSounds = this.emoteSounds?.count ?? 0;
      }
      if (this.effects) this.state.effects = { ...this.effects.stats };
      this.frames = 0;
      this.fpsAt = now;
      this.remotes.prune(now - 5000);
    }
  }

  /** What the avatar layer draws this frame: each placeholder's pose with its avatar, stance, face
   *  and the mouth its voice moves. */
  private avatarStates(poses: readonly AvatarPose[]): AvatarState[] {
    return poses.map((p) => {
      const me = p.entity === this.entity;
      return {
        entity: p.entity,
        manifest: this.worn.get(p.entity),
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        stance: me ? (this.sitting ? 'sitting' : this.me.grounded ? 'standing' : 'jumping') : (this.stances.get(p.entity) ?? 'standing'),
        face: me ? this.face : (this.faces.get(p.entity) ?? { expression: 'neutral', left: 'relaxed', right: 'relaxed' }),
        mouth: me ? undefined : this.chain?.mouthOf(p.entity),
        hidden: p.hidden === true,
        height: this.heights.get(p.entity) ?? BODY.height,
        me,
        ...this.emoteTimeOf(p.entity),
      };
    });
  }

  /** Who plays an emote with a sound, where, and since when (S5.07). */
  private emoteSoundList(now: number): Array<{ entity: number; anim: string; start: number; time: number; at: { x: number; y: number; z: number } }> {
    const out: Array<{ entity: number; anim: string; start: number; time: number; at: { x: number; y: number; z: number } }> = [];
    for (const [entity, e] of this.emotes) {
      const at = entity === this.entity ? this.me : this.remotes.at(entity, now);
      const time = this.emoteTimeOf(entity).emoteTime;
      if (at && time !== undefined && !this.state.hidden.includes(entity)) out.push({ entity, anim: e.anim, start: e.tick, time, at: { x: at.x, y: at.y, z: at.z } });
    }
    return out;
  }

  /** Seconds since a player's emote started, by the world's clock (S5.07). */
  private emoteTimeOf(entity: number): { emoteTime?: number } {
    const e = this.emotes.get(entity);
    const hz = this.conn?.welcome?.tickHz ?? 20;
    if (!e || this.serverTickAt === 0) return {};
    const nowTick = this.serverTick + ((performance.now() - this.serverTickAt) * hz) / 1000;
    return { emoteTime: Math.max(0, (nowTick - e.tick) / hz) };
  }

  /** Plays an emote or a dance (its manifest), or stops it (S5.07): sent to the world, which tells
   *  everyone with the tick it started at. Two changes a second at most; a quicker one waits. */
  playEmote(anim: string | undefined): void {
    this.wantEmote = anim;
    this.state.emote = anim ?? '';
    this.flushEmote();
  }

  private flushEmote(): void {
    if (this.wantEmote === null || this.state.status !== 'joined' || !this.conn) return;
    const wait = this.emoteSentAt + 550 - performance.now();
    if (wait > 0) {
      this.emoteTimer ??= setTimeout(() => {
        this.emoteTimer = undefined;
        this.flushEmote();
      }, wait);
      return;
    }
    this.conn.send({ type: 'emote', ...(this.wantEmote ? { anim: fromHex(this.wantEmote) } : {}) });
    this.emoteSentAt = performance.now();
    this.wantEmote = null;
  }

  /** The viewer's policy (S4.09), the frame-rate tuner, and the first visit's measurement. */
  private tunePolicy(frameMs: number, now: number): void {
    const s = this.settings.avatar;
    if (s.autoTune) this.tuner.push(frameMs, now);
    if (s.tier === 'unset' && this.state.status === 'joined' && this.state.measuredTier === undefined) {
      this.bench ??= { from: now, samples: [] };
      const since = now - this.bench.from;
      if (since > 3000 && since < 15_000) this.bench.samples.push(frameMs);
      else if (since >= 15_000) this.state.measuredTier = tierOf(this.bench.samples);
    }
    if (now - this.policyAt < 250) return;
    this.policyAt = now;
    const friends = new Set(this.state.friends);
    const safe = this.state.safeMode;
    const policy = viewerPolicy(s, s.autoTune ? this.tuner.factor : 1, {
      accountOf: (e) => this.people.get(e)?.account,
      trustOf: (e) => this.trusts.get(e) ?? 0,
      friends,
      me: this.entity,
      safe,
    });
    if (this.overlays) {
      const hidden = new Set(s.hidden);
      this.overlays.me = this.entity;
      this.overlays.safeMode = safe;
      this.overlays.accountOf = (e) => this.people.get(e)?.account;
      this.overlays.hiddenOf = (e) => {
        const account = this.people.get(e)?.account;
        return account !== undefined && (hidden.has(account) || this.state.blocked.includes(account));
      };
      this.overlays.refresh(now);
    }
    // Whose creator shaders show (S6.03, T-01): none after a GPU reset or in safe mode; the
    // viewer's own and friends'; strangers' only when allowed, not on the low tier, not shielded.
    const shadersOk = gpuResets.count === 0 && !safe;
    policy.shaders = (e) => {
      if (!shadersOk) return false;
      if (e === this.entity) return true;
      const account = this.people.get(e)?.account;
      if (account !== undefined && friends.has(account)) return true;
      return s.shadersStrangers && s.tier !== 'low' && policy.shown?.(e) !== 'impostor';
    };
    if (this.avatarLayer) this.avatarLayer.policy = policy;
    if (this.effects) {
      // Whose effects show (S6.01, Q-M10): one's own and the world's; anyone else's when their
      // avatar is not shielded or hidden, a stranger's only when the viewer allows strangers'.
      const fx = this.settings.effects;
      this.effects.allowed = (owner) => {
        if (!fx.show) return false;
        if (owner === this.entity) return true;
        // Safe mode (S6.02): nobody else's, and not the world's.
        if (safe) return false;
        if (owner === 'world') return true;
        if (policy.shown?.(owner) === 'impostor') return false;
        const account = this.people.get(owner)?.account;
        return fx.strangers || (account !== undefined && friends.has(account));
      };
      this.effects.refresh();
    }
  }

  /** What this player wears now (S5.05): sent to the world, which fits it and shows everyone. The
   *  world takes one change a second; a quicker one waits and goes as the latest. */
  wearOutfit(items: readonly Worn[]): void {
    this.wantOutfit = items.slice(0, 16).map((w) => ({ item: w.item, ...(w.adjust ? { adjust: { ...w.adjust } } : {}) }));
    this.state.outfit = this.wantOutfit;
    this.flushOutfit();
  }

  private flushOutfit(): void {
    if (!this.wantOutfit || this.state.status !== 'joined' || !this.conn) return;
    const wait = this.outfitSentAt + 1100 - performance.now();
    if (wait > 0) {
      this.outfitTimer ??= setTimeout(() => {
        this.outfitTimer = undefined;
        this.flushOutfit();
      }, wait);
      return;
    }
    this.conn.send({ type: 'outfit', items: this.wantOutfit.map((w) => ({ item: fromHex(w.item), ...(w.adjust ? { adjust: w.adjust } : {}) })) });
    this.outfitSentAt = performance.now();
    this.wantOutfit = undefined;
  }

  /** A new face or hand pose (S4.07): drawn at once here, sent to the world for everyone else. */
  setFace(change: Partial<{ expression: Expression; left: HandPose; right: HandPose }>): void {
    this.face = { ...this.face, ...change };
    this.state.expression = this.face.expression;
    if (this.state.status === 'joined') this.conn?.send({ type: 'face', ...this.face });
  }

  private avatars(now: number): AvatarPose[] {
    const list: AvatarPose[] = [];
    const myLevel = this.state.talking ? 0.6 : 0;
    list.push({
      entity: this.entity,
      x: this.me.x,
      y: this.me.y,
      z: this.me.z,
      yaw: this.controls.yaw,
      name: '',
      speaking: myLevel,
      hidden: this.state.person === 'first' || this.state.status !== 'joined',
      scale: this.scaleOf(this.entity),
      sitting: this.sitting,
    });
    for (const entity of this.remotes.entities()) {
      const p = this.remotes.at(entity, now);
      // Someone kept apart by a block is not drawn (S3.11).
      if (!p || this.state.hidden.includes(entity)) continue;
      list.push({ entity, ...p, name: this.names.get(entity) ?? '', speaking: (this.chain?.mouthOf(entity)?.level ?? 0) / 15, scale: this.scaleOf(entity), sitting: this.stances.get(entity) === 'sitting' });
    }
    return list;
  }

  private placeVoices(): void {
    if (!this.chain) return;
    const now = performance.now();
    const speakers = new Map<number, { x: number; y: number; z: number }>();
    for (const entity of this.remotes.entities()) {
      const p = this.remotes.at(entity, now);
      if (p) speakers.set(entity, { x: p.x, y: p.y + BODY.eye * this.scaleOf(entity), z: p.z });
    }
    this.chain.place({ x: this.me.x, y: this.me.y + BODY.eye * this.scaleOf(this.entity), z: this.me.z }, this.controls.yaw, speakers);
  }

  private sendPose(): void {
    if (!this.conn || this.state.status !== 'joined') return;
    this.seq = (this.seq + 1) & 0xffff;
    const m = this.me;
    const stance = this.sitting ? 'sitting' : this.physics?.flying ? 'flying' : m.grounded ? 'standing' : m.vy > 0 ? 'jumping' : 'falling';
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
        this.worldId = m.world;
        this.joinedWall = Date.now();
        break;
      case 'snapshot':
        this.snapshot(m);
        break;
      case 'roster':
        this.roster(m);
        break;
      case 'chat':
        // Never from someone kept apart, nor, for a minor, from a stranger (S3.10, S3.11): the
        // world filters these first; the client keeps the rule even with a world that does not.
        if (m.from !== undefined && !this.mayRead(m.from)) break;
        this.chatLine({ from: m.from === undefined ? '' : (this.names.get(m.from) ?? '?'), text: m.text });
        if (m.from !== this.entity) uiSound('blip');
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
      case 'portal':
        if (this.state.status === 'joined') this.onTravel?.({ world: m.world, spawn: m.spawn });
        break;
      case 'placed':
        this.placed(m);
        break;
      case 'muted':
        // The world drops this player's voice; the microphone stops sending too (S3.07).
        this.state.heldMute = m.on ? m.reason : undefined;
        break;
      case 'hidden':
        this.state.hidden = m.entities;
        this.applySilenced();
        break;
      default:
        break;
    }
  }

  private snapshot(s: MessageOf<'snapshot'>): void {
    // The world's clock, for emotes in step (S5.07).
    if (s.tick >= this.serverTick) {
      this.serverTick = s.tick;
      this.serverTickAt = performance.now();
    }
    // A refused move: back to where the server has the player.
    if (s.correction && s.correction.seq !== 0) {
      this.me = { x: s.correction.position.x, y: s.correction.position.y, z: s.correction.position.z, vy: 0, grounded: true };
      this.physics?.teleport(this.me.x, this.me.y, this.me.z);
    }
    const now = performance.now();
    for (const bytes of s.blocks) {
      const block = decodeCellBlock(bytes);
      for (const e of block.full) {
        if (e.id === this.entity) continue;
        this.remotes.push(e.id, now, { x: block.cx * CELL + e.x, y: e.y, z: block.cz * CELL + e.z, yaw: e.yaw });
        this.stances.set(e.id, e.stance);
      }
      for (const e of block.coarse) {
        if (e.id !== this.entity) this.remotes.push(e.id, now, { x: block.cx * CELL + e.x, y: e.y, z: block.cz * CELL + e.z, yaw: e.yaw });
      }
    }
  }

  private roster(r: MessageOf<'roster'>): void {
    if (r.full) {
      this.names.clear();
      this.people.clear();
    }
    if (r.full) {
      const listed = new Set(r.players.map((p) => p.entity));
      for (const id of [...this.worn.keys()]) if (!listed.has(id)) this.avatarLayer?.drop(id);
      this.worn.clear();
      this.faces.clear();
    }
    for (const p of r.players) {
      // The avatar they wear (S4.05) and their face (S4.07).
      const manifest = p.avatar ? toHex(p.avatar) : undefined;
      if (manifest) this.worn.set(p.entity, manifest);
      else this.worn.delete(p.entity);
      this.avatarLayer?.wear(p.entity, manifest);
      this.faces.set(p.entity, p.face);
      this.trusts.set(p.entity, p.trust);
      this.avatarLayer?.reshape(p.entity, p.proportions);
      // What they wear (S5.05), as the world fitted it.
      const outfit = p.outfit.map((w) => ({ item: toHex(w.item), ...(w.adjust ? { adjust: { ...w.adjust } } : {}) }));
      this.avatarLayer?.dress(p.entity, outfit);
      this.overlays?.dress(p.entity, outfit.map((w) => w.item));
      // The emote or dance they play (S5.07), and when it started.
      if (p.emote) this.emotes.set(p.entity, { anim: toHex(p.emote.anim), tick: p.emote.tick });
      else this.emotes.delete(p.entity);
      this.avatarLayer?.play(p.entity, p.emote ? toHex(p.emote.anim) : undefined);
      if (p.entity === this.entity && this.wantEmote === null) this.state.emote = p.emote ? toHex(p.emote.anim) : '';
      if (p.entity === this.entity) {
        if (!this.wantOutfit) this.state.outfit = outfit;
        // At the first roster: what this account wore last time, from the settings.
        if (!this.outfitRestored) {
          this.outfitRestored = true;
          const saved = this.settings.avatar.worn[p.account];
          if (saved && saved.length > 0 && outfit.length === 0) this.wearOutfit(saved);
        }
      }
      // A change lists a player again (a new height, a role): only a new entity is an arrival.
      const arriving = !this.names.has(p.entity);
      this.names.set(p.entity, p.name);
      this.people.set(p.entity, { entity: p.entity, account: p.account, name: p.name, role: p.role, me: p.entity === this.entity });
      this.everyone.set(p.entity, { account: p.account, name: p.name });
      this.heights.set(p.entity, p.height / 100);
      if (arriving && this.rosterSeen && p.entity !== this.entity) {
        this.chatLine({ from: '', text: p.name, notice: 'joined' });
        uiSound('chime');
      }
    }
    for (const id of r.left) {
      const name = this.names.get(id);
      if (name !== undefined && id !== this.entity) this.chatLine({ from: '', text: name, notice: 'left' });
      this.names.delete(id);
      this.people.delete(id);
      this.heights.delete(id);
      this.stances.delete(id);
      this.strides.delete(id);
      this.remotes.forget(id);
      this.worn.delete(id);
      this.faces.delete(id);
      this.trusts.delete(id);
      this.emotes.delete(id);
      this.avatarLayer?.drop(id);
      this.overlays?.drop(id);
    }
    this.rosterSeen = true;
    this.state.players = this.names.size;
    this.state.people = sortPeople(this.people.values());
    this.state.role = this.people.get(this.entity)?.role ?? 'visitor';
    this.applySilenced();
  }

  /** Loads the accounts this player muted (S3.08); the world's own guests (offline) have none. */
  /** Loads what follows the account (S3.08, S3.10, S3.11): its mutes, friends and blocks, and
   *  whether it is a minor (then its microphone starts muted). An offline guest has none. */
  async loadSocial(): Promise<void> {
    const [mutes, social] = await Promise.all([window.flatchat?.mutes(), window.flatchat?.social()]);
    if (mutes?.ok) this.state.silenced = mutes.accounts;
    if (social?.ok) {
      this.state.friends = social.friends.map((p) => p.account);
      this.state.incoming = social.incoming.map((p) => p.account);
      this.state.outgoing = social.outgoing.map((p) => p.account);
      this.state.blocked = social.blocks;
      this.state.minor = social.under18;
      if (social.under18) this.state.muted = true;
    }
    this.applySilenced();
  }

  /** Asks someone to be friends, accepts their request, or ends it (S3.10). */
  async befriend(account: string, on: boolean): Promise<string | undefined> {
    const r = await window.flatchat?.befriend(account, on);
    if (!r?.ok) return r?.error ?? 'failed';
    const without = (list: string[]): string[] => list.filter((a) => a !== account);
    this.state.incoming = without(this.state.incoming);
    if (!on) {
      this.state.friends = without(this.state.friends);
      this.state.outgoing = without(this.state.outgoing);
    } else if (r.status === 'accepted' || r.status === 'already') this.state.friends = [...new Set([...this.state.friends, account])];
    else this.state.outgoing = [...new Set([...this.state.outgoing, account])];
    this.applySilenced();
    return undefined;
  }

  /** Blocks or unblocks someone in every world (the core keeps it) and in this one at once. */
  async block(account: string, on: boolean): Promise<boolean> {
    const r = await window.flatchat?.setBlock(account, on);
    if (!r?.ok) return false;
    this.conn?.send({ type: 'block', account, on });
    const without = (list: string[]): string[] => list.filter((a) => a !== account);
    this.state.blocked = on ? [...new Set([...this.state.blocked, account])] : without(this.state.blocked);
    if (on) {
      this.state.friends = without(this.state.friends);
      this.state.incoming = without(this.state.incoming);
      this.state.outgoing = without(this.state.outgoing);
    }
    return true;
  }

  /** Whether this player may read or hear an entity: not across a block, and for a minor, its
   *  friends only (S3.10, S3.11). */
  private mayRead(entity: number): boolean {
    if (this.state.hidden.includes(entity)) return false;
    if (!this.state.minor) return true;
    const account = this.people.get(entity)?.account;
    return account !== undefined && this.state.friends.includes(account);
  }

  /** Mutes or unmutes one person for this account, in every world (S3.08). */
  async setPersonalMute(account: string, on: boolean): Promise<boolean> {
    const r = await window.flatchat?.setMute(account, on);
    if (!r?.ok) return false;
    this.state.silenced = on ? [...new Set([...this.state.silenced, account])] : this.state.silenced.filter((a) => a !== account);
    this.applySilenced();
    return true;
  }

  /** The voices to drop: the muted accounts' entities here, those kept apart, and for a minor
   *  everyone but its friends. */
  private applySilenced(): void {
    if (!this.chain) return;
    const muted = new Set(this.state.silenced);
    this.chain.silenced = new Set([...this.people.values()].filter((p) => !p.me && (muted.has(p.account) || !this.mayRead(p.entity))).map((p) => p.entity));
  }

  toggleEarmuffs(): void {
    this.state.earmuffs = !this.state.earmuffs;
    if (this.chain) this.chain.earmuffs = this.state.earmuffs;
  }

  /** A report from this world (S3.02): the player's choices, the evidence this visit holds, and
   *  the voice clip when the player keeps it. */
  reportOf(draft: ReportDraft, instance: string): ReportPayload {
    const now = performance.now();
    const wall = (t: number): number => Date.now() - (now - t);
    const near = [...this.remotes.entities()].flatMap((entity) => {
      const p = this.remotes.at(entity, now);
      const who = this.everyone.get(entity);
      return p && who ? [{ account: who.account, name: who.name, distance: Math.hypot(p.x - this.me.x, p.y - this.me.y, p.z - this.me.z) }] : [];
    });
    const evidence: ReportEvidence = {
      world: { id: this.worldId, name: this.state.world, instance },
      chat: this.state.chat
        .filter((l) => !l.notice)
        .slice(-50)
        .map((l) => ({ from: l.from, text: l.text, at: l.at })),
      near: near.sort((a, b) => a.distance - b.distance).slice(0, 64),
      times: { joined: this.joinedWall, reported: Date.now() },
    };
    return buildReport(draft, evidence, this.recorder, now, wall, (entity) => this.everyone.get(entity));
  }

  /** The world's screen effects as the viewer allows them now (S6.05): the pipeline is made again
   *  only when that changes (a setting, safe mode, a new world). */
  private updateLook(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (!this.renderer) return;
    const on = lookEffects(this.look, this.settings.look, this.state.safeMode);
    const key = `${JSON.stringify(on)}|${JSON.stringify(this.look)}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    this.lookPipeline?.dispose();
    this.lookPipeline = undefined;
    this.state.look = on;
    if (!on.bloom && !on.shafts && !on.reflections && !on.filters) return;
    try {
      this.lookPipeline = new LookPipeline(this.renderer, scene, camera, this.look, on, this.sun);
    } catch {
      // A screen effect this GPU cannot make: the plain picture.
      this.state.look = { bloom: false, shafts: false, reflections: false, filters: false };
    }
  }

  /** The safe-mode key (S6.02, T-14): every other avatar to its fallback, every overlay and
   *  everyone else's effects off, at once; pressed again, everything back as the viewer had it. */
  toggleSafeMode(): void {
    this.state.safeMode = !this.state.safeMode;
    // Applied on the next frame, not after the policy's quarter second.
    this.policyAt = -Infinity;
  }

  /** Asks the world to kick, ban or mute someone, with the reason they are told (S3.07). */
  moderate(account: string, action: 'kick' | 'ban' | 'unban' | 'mute' | 'unmute', minutes: number, reason: string): void {
    if (this.state.status === 'joined') this.conn?.send({ type: 'moderate', account, action, minutes, reason: reason.slice(0, 160) });
  }

  /** Asks the world to give someone a role (S3.06); the world checks it and the roster answers. */
  giveRole(account: string, role: Role): void {
    if (this.state.status === 'joined') this.conn?.send({ type: 'role', account, role });
  }

  private chatLine(line: Omit<ChatLine, 'id' | 'at'>): void {
    this.state.chat.push({ id: (this.chatId += 1), at: Date.now(), ...line });
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
      this.pickables.push(group);
    }
    // The world's effects (S6.01): each at its marker, measured here before it plays.
    for (const e of world.scenes.flatMap((sc) => sc.effects)) {
      const bytes = files.get(e.file);
      if (!bytes || !this.effects || !this.scene) continue;
      const marker = new THREE.Object3D();
      marker.name = 'flatchat-world-effect';
      marker.matrixAutoUpdate = false;
      marker.matrix.fromArray(e.matrix);
      this.scene.add(marker);
      marker.updateMatrixWorld(true);
      void this.effects.wearWorld(e, marker, bytes);
    }
    // The world's look (S6.05): its sky, fog and light now; its screen effects from the next frame.
    this.look = world.manifest.look ?? DEFAULT_LOOK;
    const extent = Math.max(world.bounds.max[0] - world.bounds.min[0], world.bounds.max[2] - world.bounds.min[2]);
    if (this.scene) this.sun = applyLook(this.scene, this.look, extent).sun;
    this.lookKey = '';
    // The world's screen overlays (S6.02): on for everyone until a viewer switches them off.
    this.overlays?.setWorld(world.overlays ?? [], files);
    // The base library's parts, drawn from the client's own definitions (S2.05).
    const parts = world.scenes.flatMap((sc) => sc.parts);
    if (parts.length > 0) {
      const group = buildParts(parts);
      this.scene?.add(group);
      this.pickables.push(group);
      this.state.parts = parts.length;
    }
    this.canFly = world.manifest.flying;
    this.seats = world.scenes.flatMap((sc) => sc.seats.map((seat) => ({ x: seat.position[0], y: seat.position[1], z: seat.position[2], yaw: seat.yaw })));
    if (this.sounds) this.state.sounds = await this.sounds.start(world, files);
    const mesh = world.navmesh ? files.get(world.navmesh) : undefined;
    if (mesh) {
      try {
        this.navigation = await Navigation.load(mesh);
      } catch {
        // No paths: walking to a spot goes straight there.
      }
    }
    this.cameraSolids = colliders.filter((c) => c.type === 'box').map((c) => ({
      min: { x: c.position[0] - c.half[0], y: c.position[1] - c.half[1], z: c.position[2] - c.half[2] },
      max: { x: c.position[0] + c.half[0], y: c.position[1] + c.half[1], z: c.position[2] + c.half[2] },
    }));
    this.state.world = world.manifest.name;
    this.state.download = undefined;
  }

  /** The ears at the camera; a footstep for each stride of the player and of anyone within 12 m. */
  private footsteps(now: number, ears: { x: number; y: number; z: number }): void {
    const sounds = this.sounds!;
    sounds.listen(ears, this.controls.yaw, this.controls.pitch);
    this.emoteSounds?.update(this.emoteSoundList(now), ears);
    const flying = this.physics?.flying ?? false;
    if (this.myStrides.step(this.me.x, this.me.z, this.me.grounded && !flying && !this.sitting, this.controls.held('run'))) sounds.footstep();
    for (const entity of this.remotes.entities()) {
      const p = this.remotes.at(entity, now);
      if (!p) continue;
      let s = this.strides.get(entity);
      if (!s) this.strides.set(entity, (s = new Strides()));
      const stance = this.stances.get(entity) ?? 'standing';
      const near = Math.hypot(p.x - this.me.x, p.z - this.me.z) <= 12;
      if (s.step(p.x, p.z, stance === 'standing', false) && near) sounds.footstep({ x: p.x, y: p.y, z: p.z }, 0.18);
    }
    if (this.state.footsteps !== sounds.steps) this.state.footsteps = sounds.steps;
  }

  /** A player's drawn size: the world's fitted height over the standard body's. */
  private scaleOf(entity: number): number {
    const h = this.heights.get(entity);
    return h ? h / BODY.height : 1;
  }

  private notice(key: WorldState['notice']): void {
    this.state.notice = key;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.state.notice = ''), 3000);
  }

  private toggleFlying(): void {
    if (!this.physics) return;
    if (!this.canFly) return this.notice('noFlying');
    this.physics.flying = !this.physics.flying;
    this.state.flying = this.physics.flying;
    this.sitting = false;
  }

  /** Stands a seated player up, or asks the world for the nearest seat within 2.5 m. */
  private sitOrStand(): void {
    if (this.sitting) {
      this.sitting = false;
      return;
    }
    let best = -1;
    let bestD = 2.5;
    this.seats.forEach((seat, i) => {
      const d = Math.hypot(seat.x - this.me.x, seat.z - this.me.z);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best < 0) return this.notice('noSeat');
    const seat = this.seats[best]!;
    this.conn?.send({ type: 'teleport', position: { x: seat.x, y: seat.y, z: seat.z }, yaw: seat.yaw, seat: best });
  }

  /** The spot under the crosshair: walk there (along the navigation mesh when the world has one),
   *  or ask the world to teleport there. */
  private toSpot(teleport: boolean): void {
    if (!this.camera) return;
    this.ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.ray.far = 60;
    const hit = this.ray.intersectObjects(this.pickables, true)[0];
    if (!hit) return this.notice('nothingThere');
    const to = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    if (teleport) {
      this.conn?.send({ type: 'teleport', position: to, yaw: this.controls.yaw });
      return;
    }
    this.sitting = false;
    this.walker = new PathWalker(this.navigation?.path(this.me, to) ?? [to]);
  }

  /** The world's answer to a seat or a teleport. */
  private placed(m: MessageOf<'placed'>): void {
    if (!m.accepted) return this.notice('teleportRefused');
    this.walker = undefined;
    this.me = { x: m.position.x, y: m.position.y, z: m.position.z, vy: 0, grounded: true };
    this.physics?.teleport(m.position.x, m.position.y, m.position.z);
    this.controls.yaw = m.yaw;
    this.sitting = m.stance === 'sitting';
  }

  /** Leaves the world (`travel` through a portal) and lets go of the renderer, the microphone and the loops. */
  leave(reason: 'quit' | 'travel' = 'quit'): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const d of this.detachers) d();
    this.detachers = [];
    this.unlock();
    this.downloader?.cancel();
    this.conn?.close(reason === 'travel' ? 'went through a portal' : 'left the world', reason);
    this.physics?.dispose();
    this.navigation?.dispose();
    this.emoteSounds?.close();
    this.sounds?.close();
    this.overlays?.dispose();
    this.lookPipeline?.dispose();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.outfitTimer) clearTimeout(this.outfitTimer);
    if (this.emoteTimer) clearTimeout(this.emoteTimer);
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.chain?.close();
    void this.renderer?.setAnimationLoop(null);
    this.renderer?.dispose();
  }
}

const HANDS: readonly HandPose[] = ['relaxed', 'point', 'peace', 'thumbsUp', 'fist', 'open', 'rock'];
/** The next hand pose in the cycle R steps through. */
function nextHand(h: HandPose): HandPose {
  return HANDS[(HANDS.indexOf(h) + 1) % HANDS.length]!;
}

/** Proportions as shares (the settings) into percent (the protocol). */
function percent(p: { width: number; arms: number; legs: number; head: number }): { width: number; arms: number; legs: number; head: number } {
  const c = (v: number): number => Math.round(Math.min(125, Math.max(80, v * 100)));
  return { width: c(p.width), arms: c(p.arms), legs: c(p.legs), head: c(p.head) };
}


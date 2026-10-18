// SPDX-License-Identifier: MPL-2.0
// Players' own avatars in the world (S4.05 runtime avatars, S4.06 shared locomotion, S4.07 faces
// and hands, S4.08 spring bones). Each player's worn avatar comes from the core by its manifest's
// hash (the main process fetches and caches the files); the layer picks a level for each by
// distance and the viewer's policy (S4.09): the nearest few in full (LOD0), the next at LOD1 or
// LOD2, everyone else as the impostor. Work is paced: one level fetched and parsed at a time, and a
// level switches only after the wish to switch has held for a moment. Only avatars in view are
// posed and drawn (the layer culls each one's holder: three.js culls no groups).
//
// Proportions (S4.10) move joints, not scales: the elbows, wrists, knees and ankles along their
// bones, the shoulders and hips apart, the head's size; skinning stretches each segment, and an
// avatar with longer legs is raised so its feet stay on the ground.
//
// LOD0 to LOD2 are each player's own three-vrm VRM (its expressions, its spring bones); impostors
// of one avatar share one parsed template (geometry, material and texture once on the GPU) and are
// posed straight on their bones with three-vrm's own normalized-to-raw rule, so 200 of them cost
// little more than their draw calls.
//
// Outfits (S5.05) go on LOD0 to LOD2: on a standard body, the clothes made for it (each fit on the
// avatar's own bones, the regions it hides taken off the body); on any avatar, the props at their
// points (outfit.ts). Items conflicting in the roster are settled as a toggle settles them, the one
// worn later winning (resolveOutfit). Each item's manifest and files are parsed once and shared by
// every avatar wearing it; one outfit is put on at a time. Impostors wear none.
//
// Emotes and dances (S5.07) play on LOD0 to LOD2: the roster says which VRMA and the world tick it
// started at; three-vrm-animation retargets it onto the avatar's normalized humanoid, set to the
// time since that tick (a dance loops, an emote plays once and hands back to walking). Each VRMA is
// parsed once and shared. Impostors keep walking.
import type { AnimationManifest, AvatarManifest, BodyKit, ItemManifest, Level, Rank, Region } from '@flatchat/content';
import { rankIndex, resolveOutfit } from '@flatchat/content';
import type { VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import * as THREE from 'three/webgpu';
import { disposeLevel, parseAnimation, parseItemFile, parseLevel } from './avatar-loader';
import { type BoneAngles, type Expression, gaitOf, handPose, type HandPose, locomotion, mouthShapes, strideRate } from './avatar-pose';
import { type FitTemplate, fitTemplate, hideRegions, restPlaces, wearFit, wearProp } from './outfit';

export interface AvatarState {
  entity: number;
  /** The worn avatar's manifest hash, from the roster; none: the placeholder stays. */
  manifest: string | undefined;
  x: number;
  y: number;
  z: number;
  yaw: number;
  stance: string;
  face: { expression: Expression; left: HandPose; right: HandPose };
  /** The voice frame's mouth shapes, 0 to 15 (S4.07). */
  mouth: { aa: number; ih: number; ou: number; ee: number; oh: number } | undefined;
  hidden: boolean;
  /** The player's height in metres, as the world fitted it (S2.07). */
  height: number;
  /** This player's own avatar: always in full. */
  me: boolean;
  /** Seconds since the emote or dance it plays started (S5.07), when one plays. */
  emoteTime?: number;
}

export interface AvatarPolicy {
  /** How many avatars are drawn in full, nearest first. */
  full: number;
  /** How many more at LOD1 or LOD2. */
  lower: number;
  /** Spring bones move on the nearest this many (S4.08). */
  springs: number;
  /** The worst rank drawn in full; worse avatars show at LOD1 at best (S4.09). */
  minRank: Rank;
  /** Entities the viewer chose to see as impostors (S4.09). */
  shown?: (entity: number) => 'full' | 'impostor';
}

export const DEFAULT_POLICY: AvatarPolicy = { full: 8, lower: 20, springs: 6, minRank: 'poor' };

export type Fetcher = (manifest: string, level: Level) => Promise<{ bytes: ArrayBuffer; manifest: AvatarManifest; kit?: BodyKit }>;
/** An item's manifest (`manifest`), or its manifest and one of its files: a body's fit, or the prop. */
export type ItemFetcher = (manifest: string, part: 'manifest' | 'prop' | BodyKit) => Promise<{ manifest: ItemManifest; bytes?: ArrayBuffer }>;
/** An emote's or a dance's manifest and its VRMA (S5.07). */
export type AnimationFetcher = (manifest: string) => Promise<{ manifest: AnimationManifest; bytes: ArrayBuffer }>;
/** A worn item, as the roster gives it: its manifest's SHA-256 in hex and a prop's adjustment. */
export interface Worn {
  item: string;
  adjust?: { x: number; y: number; z: number; rx: number; ry: number; rz: number; scale: number };
}
export interface Proportions {
  width: number;
  arms: number;
  legs: number;
  head: number;
}
const AS_MADE: Proportions = { width: 100, arms: 100, legs: 100, head: 100 };
/** The joints proportions move: along their bone for length, sideways for width. */
const LENGTH_JOINTS: Record<'arms' | 'legs', string[]> = {
  arms: ['leftLowerArm', 'leftHand', 'rightLowerArm', 'rightHand'],
  legs: ['leftLowerLeg', 'leftFoot', 'rightLowerLeg', 'rightFoot'],
};
const WIDTH_JOINTS = ['leftShoulder', 'rightShoulder', 'leftUpperLeg', 'rightUpperLeg'];
const WIDTH_FALLBACK: Record<string, string> = { leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm' };

const FULL_WITHIN = 8;
const LOWER_WITHIN = 18;
const LOD2_WITHIN = 35;
const SWITCH_AFTER_MS = 700;

interface Template {
  vrm: VRM;
  hipsHeight: number;
  /** Per humanoid bone: its node's name in the template, the parent's world rotation and its own
   *  local rotation at rest (three-vrm's normalized-to-raw rule needs both). */
  bones: Map<string, { name: string; parentWorld: THREE.Quaternion; rest: THREE.Quaternion; restPosition: THREE.Vector3 }>;
  users: number;
}

interface Entry {
  manifest: string;
  info: AvatarManifest | undefined;
  level: Level | undefined;
  want: Level | undefined;
  wantSince: number;
  holder: THREE.Group;
  /** LOD0 to LOD2: the player's own VRM. */
  vrm: VRM | undefined;
  hipsHeight: number;
  /** The impostor: a clone of the template, its humanoid nodes by bone name. */
  impostor: { root: THREE.Object3D; nodes: Map<string, THREE.Object3D> } | undefined;
  failed: boolean;
  /** The player's proportions in percent (S4.10), and each moved joint's position at rest. */
  proportions: Proportions;
  rest: Map<string, THREE.Vector3>;
  /** How much the legs grew, in the avatar's metres: the holder rises by it. */
  lift: number;
  phase: number;
  speed: number;
  last: { x: number; z: number; t: number } | undefined;
  blinkAt: number;
  /** The standard body this avatar is (from its delivery), when it is one. */
  kit: BodyKit | undefined;
  /** What the player wears (S5.05), the outfit put on the current level (its key), and what was added. */
  outfit: Worn[];
  dressed: string | undefined;
  worn: THREE.Object3D[];
  wornItems: number;
  /** Each bone's place at rest on the current level, for props. */
  rest2: Map<string, THREE.Matrix4> | undefined;
  /** The emote or dance it plays (S5.07), and its action on the current level once loaded. */
  emote: string | undefined;
  playing: { anim: string; vrm: VRM; mixer: THREE.AnimationMixer; action: THREE.AnimationAction; duration: number; loop: boolean } | undefined;
  /** The emote last loaded or tried for this level: tried once, not every frame. */
  emoteTried: string | undefined;
}

const euler = new THREE.Euler();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

export class AvatarLayer {
  readonly group = new THREE.Group();
  policy: AvatarPolicy = DEFAULT_POLICY;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly fetch: Fetcher;
  private readonly entries = new Map<number, Entry>();
  private readonly templates = new Map<string, Promise<Template>>();
  private busy = false;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly bounds = new THREE.Sphere();
  private readonly centre = new THREE.Vector3();
  /** Avatars posed and drawn in the last update (in view), for the report and the tests. */
  inView = 0;
  /** Loads done and failed, for the report and the tests. */
  loads = 0;
  failures = 0;
  /** Items that could not be put on (S5.05). */
  itemFailures = 0;
  private readonly fetchItem: ItemFetcher | undefined;
  private dressing = false;
  private readonly itemManifests = new Map<string, Promise<ItemManifest>>();
  private readonly fits = new Map<string, Promise<FitTemplate>>();
  private readonly props = new Map<string, Promise<THREE.Object3D>>();
  private readonly pendingOutfits = new Map<number, Worn[]>();
  private readonly fetchAnimation: AnimationFetcher | undefined;
  private readonly animations = new Map<string, Promise<{ animation: VRMAnimation; manifest: AnimationManifest }>>();
  private readonly pendingEmotes = new Map<number, string | undefined>();
  /** Emotes that could not be played. */
  emoteFailures = 0;

  constructor(renderer: THREE.WebGPURenderer, fetch: Fetcher, fetchItem?: ItemFetcher, fetchAnimation?: AnimationFetcher) {
    this.renderer = renderer;
    this.fetch = fetch;
    this.fetchItem = fetchItem;
    this.fetchAnimation = fetchAnimation;
  }

  /** The emote or dance a player plays changed (a roster entry, S5.07): its manifest, or none. */
  play(entity: number, anim: string | undefined): void {
    this.pendingEmotes.set(entity, anim);
    const e = this.entries.get(entity);
    if (!e || e.emote === anim) return;
    e.emote = anim;
    e.emoteTried = undefined;
    this.stopPlaying(e);
  }

  /** Whether a player's avatar is playing an emote or a dance in this frame. */
  emoting(entity: number): boolean {
    return this.entries.get(entity)?.playing?.action.isRunning() === true;
  }

  private stopPlaying(e: Entry): void {
    if (!e.playing) return;
    e.playing.action.stop();
    e.playing.mixer.uncacheRoot(e.playing.vrm.scene);
    e.playing = undefined;
  }

  /** The emote's VRMA, parsed once and shared by every avatar playing it. */
  private animation(hash: string): Promise<{ animation: VRMAnimation; manifest: AnimationManifest }> {
    let a = this.animations.get(hash);
    if (!a) {
      a = (async () => {
        const got = await this.fetchAnimation!(hash);
        return { animation: await parseAnimation(this.renderer, got.bytes), manifest: got.manifest };
      })();
      a.catch(() => this.animations.delete(hash));
      this.animations.set(hash, a);
    }
    return a;
  }

  /** Readies an entry's emote on its current level (once per level and emote). */
  private readyEmote(e: Entry): void {
    const vrm = e.vrm;
    const anim = e.emote;
    if (!vrm || !anim || !this.fetchAnimation || e.emoteTried === anim || (e.playing && e.playing.anim === anim && e.playing.vrm === vrm)) return;
    if (e.playing) this.stopPlaying(e);
    e.emoteTried = anim;
    void this.animation(anim)
      .then(({ animation, manifest }) => {
        if (e.vrm !== vrm || e.emote !== anim) return;
        const mixer = new THREE.AnimationMixer(vrm.scene);
        const action = mixer.clipAction(createVRMAnimationClip(animation, vrm));
        action.setLoop(manifest.use === 'dance' ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        action.clampWhenFinished = false;
        action.play();
        e.playing = { anim, vrm, mixer, action, duration: manifest.duration, loop: manifest.use === 'dance' };
        e.emoteTried = undefined;
      })
      .catch(() => {
        this.emoteFailures += 1;
      });
  }

  /** What a player wears changed (a roster entry, S5.05). */
  dress(entity: number, outfit: readonly Worn[]): void {
    const list = outfit.map((w) => ({ item: w.item, ...(w.adjust ? { adjust: { ...w.adjust } } : {}) }));
    this.pendingOutfits.set(entity, list);
    const e = this.entries.get(entity);
    if (!e || JSON.stringify(e.outfit) === JSON.stringify(list)) return;
    e.outfit = list;
    e.dressed = undefined;
  }

  /** The avatar a player wears changed (a roster entry). */
  wear(entity: number, manifest: string | undefined): void {
    const e = this.entries.get(entity);
    if (e && e.manifest === manifest) return;
    if (e) this.drop(entity);
    if (!manifest) return;
    const holder = new THREE.Group();
    this.group.add(holder);
    this.entries.set(entity, {
      manifest,
      info: undefined,
      level: undefined,
      want: undefined,
      wantSince: 0,
      holder,
      vrm: undefined,
      hipsHeight: 0.9,
      impostor: undefined,
      failed: false,
      proportions: this.pending.get(entity) ?? AS_MADE,
      rest: new Map(),
      lift: 0,
      phase: 0,
      speed: 0,
      last: undefined,
      blinkAt: 0,
      kit: undefined,
      outfit: this.pendingOutfits.get(entity) ?? [],
      dressed: undefined,
      worn: [],
      wornItems: 0,
      rest2: undefined,
      emote: this.pendingEmotes.get(entity),
      playing: undefined,
      emoteTried: undefined,
    });
  }

  /** Proportions known before the avatar arrives (a roster entry comes first). */
  private readonly pending = new Map<number, Proportions>();

  /** A player's proportions (S4.10), from the roster. */
  reshape(entity: number, p: Proportions): void {
    this.pending.set(entity, p);
    const e = this.entries.get(entity);
    if (!e) return;
    e.proportions = p;
    this.applyProportions(e);
  }

  /** Moves the current level's joints by the entry's proportions, from their rest positions. */
  private applyProportions(e: Entry): void {
    const node = (bone: string): THREE.Object3D | undefined =>
      e.vrm ? (e.vrm.humanoid.getRawBoneNode(bone as Parameters<VRM['humanoid']['getRawBoneNode']>[0]) ?? undefined) : e.impostor?.nodes.get(bone);
    const restOf = (bone: string, n: THREE.Object3D): THREE.Vector3 => {
      let r = e.rest.get(bone);
      if (!r) {
        r = n.position.clone();
        e.rest.set(bone, r);
      }
      return r;
    };
    const p = e.proportions;
    let legLength = 0;
    for (const kind of ['arms', 'legs'] as const) {
      for (const bone of LENGTH_JOINTS[kind]) {
        const n = node(bone);
        if (!n) continue;
        const r = restOf(bone, n);
        n.position.copy(r).multiplyScalar(p[kind] / 100);
        if (kind === 'legs') legLength += r.length() / 2;
      }
    }
    for (const bone of WIDTH_JOINTS) {
      const name = node(bone) ? bone : WIDTH_FALLBACK[bone];
      const n = name ? node(name) : undefined;
      if (!n || !name) continue;
      const r = restOf(name, n);
      n.position.set(r.x * (p.width / 100), r.y, r.z);
    }
    node('head')?.scale.setScalar(p.head / 100);
    e.lift = legLength * (p.legs / 100 - 1);
  }

  /** A player left. */
  drop(entity: number): void {
    this.pending.delete(entity);
    this.pendingOutfits.delete(entity);
    this.pendingEmotes.delete(entity);
    const e = this.entries.get(entity);
    if (!e) return;
    this.clear(e);
    this.group.remove(e.holder);
    this.entries.delete(entity);
  }

  private clear(e: Entry): void {
    e.rest = new Map();
    // The worn items share their parsed files with every other wearer: off before the level goes.
    this.undress(e);
    this.stopPlaying(e);
    e.emoteTried = undefined;
    e.rest2 = undefined;
    if (e.vrm) {
      e.holder.remove(e.vrm.scene);
      disposeLevel(e.vrm);
      e.vrm = undefined;
    }
    if (e.impostor) {
      e.holder.remove(e.impostor.root);
      e.impostor = undefined;
      void this.templates.get(e.manifest)?.then((t) => (t.users -= 1));
    }
  }

  /** Draws this frame; answers the entities whose own avatar is on screen (their placeholder goes). */
  update(states: readonly AvatarState[], camera: THREE.Camera, dt: number, now: number): Set<number> {
    const drawn = new Set<number>();
    const from = camera.position;
    camera.updateWorldMatrix(true, false);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem, camera.reversedDepth);
    this.inView = 0;
    // Anyone not in this frame's list (out of the snapshot, kept apart by a block) is not drawn.
    for (const e of this.entries.values()) e.holder.visible = false;
    const ordered = states
      .filter((s) => s.manifest && this.entries.has(s.entity))
      .map((s) => ({ s, d: Math.hypot(s.x - from.x, s.z - from.z) }))
      .sort((a, b) => (a.s.me ? -1 : b.s.me ? 1 : a.d - b.d));
    let full = 0;
    let lower = 0;
    let springs = 0;
    for (const { s, d } of ordered) {
      const e = this.entries.get(s.entity)!;
      // Where it wants to be drawn: the viewer's policy decides how many get each level.
      const fullOk = e.info ? rankIndex(e.info.rank) <= rankIndex(this.policy.minRank) : true;
      const forced = this.policy.shown?.(s.entity) === 'impostor';
      let want: Level = 'impostor';
      if (!forced && (s.me || (d < FULL_WITHIN && full < this.policy.full && fullOk))) {
        want = 'lod0';
        full += 1;
      } else if (!forced && d < LOWER_WITHIN && lower < this.policy.lower) {
        want = 'lod1';
        lower += 1;
      } else if (!forced && d < LOD2_WITHIN && lower < this.policy.lower) {
        want = 'lod2';
        lower += 1;
      }
      if (want !== e.want) {
        e.want = want;
        e.wantSince = now;
      }
      if (!e.failed && want !== e.level && (e.level === undefined || now - e.wantSince > SWITCH_AFTER_MS)) this.request(s.entity, e, want);
      // three.js culls meshes, never groups, and an avatar's skinned meshes move past their bounds
      // (culling is off on them): the holder is culled here as a whole, by a sphere around the body,
      // and an avatar out of view is neither posed nor drawn. This player's own always is.
      const h = s.height > 0.2 ? s.height : 1.7;
      const inView = s.me || this.frustum.intersectsSphere(this.bounds.set(this.centre.set(s.x, s.y + h / 2, s.z), h * 0.8));
      e.holder.visible = !s.hidden && inView;
      if (e.level === undefined) continue;
      if (inView) {
        this.place(e, s, dt, now, springs < this.policy.springs && e.level !== 'impostor' && d < FULL_WITHIN * 1.5);
        if (e.level !== 'impostor') springs += 1;
        if (!s.hidden) this.inView += 1;
        if (e.vrm && e.dressed !== this.outfitKey(e)) this.dressUp(s.entity, e);
        if (e.vrm && e.emote) this.readyEmote(e);
      }
      if (!s.hidden) drawn.add(s.entity);
    }
    return drawn;
  }

  /** One load at a time: fetch, parse, then swap in. */
  private request(entity: number, e: Entry, level: Level): void {
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try {
        if (level === 'impostor') {
          const t = await this.template(e.manifest);
          if (this.entries.get(entity) !== e) return;
          this.clear(e);
          const root = cloneSkinned(t.vrm.scene);
          const nodes = new Map<string, THREE.Object3D>();
          for (const [bone, b] of t.bones) {
            const n = root.getObjectByName(b.name);
            if (n) nodes.set(bone, n);
          }
          root.traverse((o) => ((o as THREE.Mesh).frustumCulled = false));
          e.impostor = { root, nodes };
          e.hipsHeight = t.hipsHeight;
          e.holder.add(root);
          t.users += 1;
        } else {
          const got = await this.fetch(e.manifest, level);
          e.info = got.manifest;
          const parsed = await parseLevel(this.renderer, got.bytes);
          if (this.entries.get(entity) !== e) {
            disposeLevel(parsed.vrm);
            return;
          }
          this.clear(e);
          e.vrm = parsed.vrm;
          e.hipsHeight = parsed.hipsHeight;
          e.kit = got.kit;
          // Taken while the level stands at rest: where each prop's point is measured from.
          e.rest2 = restPlaces(parsed.vrm.scene);
          e.holder.add(parsed.vrm.scene);
        }
        e.level = level;
        this.applyProportions(e);
        this.loads += 1;
      } catch (err) {
        this.failures += 1;
        this.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
        e.failed = true;
      } finally {
        this.busy = false;
      }
    })();
  }

  /** An avatar's impostor, parsed once and shared by every player wearing it. */
  private template(manifest: string): Promise<Template> {
    let t = this.templates.get(manifest);
    if (!t) {
      t = (async () => {
        const got = await this.fetch(manifest, 'impostor');
        const parsed = await parseLevel(this.renderer, got.bytes);
        const bones = new Map<string, { name: string; parentWorld: THREE.Quaternion; rest: THREE.Quaternion; restPosition: THREE.Vector3 }>();
        parsed.vrm.scene.updateMatrixWorld(true);
        for (const [bone, raw] of Object.entries(parsed.vrm.humanoid.humanBones)) {
          const node = raw?.node;
          if (!node) continue;
          if (!node.name) node.name = `flatchat-impostor-${bone}`;
          const parentWorld = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
          bones.set(bone, { name: node.name, parentWorld, rest: node.quaternion.clone(), restPosition: node.position.clone() });
        }
        return { vrm: parsed.vrm, hipsHeight: parsed.hipsHeight, bones, users: 0 };
      })();
      t.catch(() => this.templates.delete(manifest));
      this.templates.set(manifest, t);
    }
    return t;
  }

  /** Places and poses one avatar for this frame. */
  private place(e: Entry, s: AvatarState, dt: number, now: number, springs: boolean): void {
    // Speed from the positions it was drawn at, smoothed.
    if (e.last && now > e.last.t) {
      const v = Math.hypot(s.x - e.last.x, s.z - e.last.z) / ((now - e.last.t) / 1000);
      e.speed = e.speed * 0.8 + Math.min(12, v) * 0.2;
    }
    e.last = { x: s.x, z: s.z, t: now };
    const gait = gaitOf(e.speed, s.stance);
    e.phase = (e.phase + strideRate(e.speed) * dt) % (Math.PI * 2);
    const pose = locomotion(gait, e.phase, now / 1000);
    const height = e.info?.height && e.info.height > 0.3 ? e.info.height : 1.7;
    const scale = s.height > 0.2 ? s.height / height : 1;
    // A seated avatar's hips come down to the seat.
    const sink = gait === 'sit' ? (e.hipsHeight - 0.1) * scale : 0;
    e.holder.position.set(s.x, s.y - sink + (pose.bob * e.hipsHeight + e.lift) * scale, s.z);
    // VRM faces +Z; a player's yaw 0 faces -Z (the placeholder's visor).
    e.holder.rotation.set(0, s.yaw + Math.PI, 0);
    e.holder.scale.setScalar(scale);
    if (e.vrm) {
      const vrm = e.vrm;
      vrm.humanoid.resetNormalizedPose();
      // An emote or a dance (S5.07) holds the body while it plays: at the time since it started
      // (a dance round and round, an emote once); otherwise the shared walk and the hands' pose.
      const p = e.playing && e.playing.vrm === vrm && s.emoteTime !== undefined ? e.playing : undefined;
      const t = p ? (p.loop ? s.emoteTime! % Math.max(p.duration, 1 / 30) : s.emoteTime!) : 0;
      if (p && (p.loop || t <= p.duration)) {
        if (!p.action.isRunning()) p.action.reset().play();
        p.action.time = t;
        p.mixer.update(0);
      } else {
        if (p?.action.isRunning()) p.action.stop();
        const bones: BoneAngles = { ...pose.bones, ...handPose(s.face.left, s.face.right) };
        for (const [bone, [x, y, z]] of Object.entries(bones)) vrm.humanoid.getNormalizedBoneNode(bone as Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0])?.rotation.set(x, y, z);
      }
      const ex = vrm.expressionManager;
      if (ex) {
        const mouth = mouthShapes(s.mouth);
        for (const [k, v] of Object.entries(mouth)) ex.setValue(k, v);
        for (const name of ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const) ex.setValue(name, s.face.expression === name ? 1 : 0);
        // A blink every few seconds, 150 ms long.
        if (now > e.blinkAt + 150) e.blinkAt = now + 2000 + Math.random() * 4000;
        ex.setValue('blink', now > e.blinkAt && now < e.blinkAt + 150 ? 1 : 0);
      }
      if (springs) vrm.update(dt);
      else {
        vrm.humanoid.update();
        vrm.expressionManager?.update();
      }
    } else if (e.impostor) {
      this.poseImpostor(e, pose.bones);
    }
  }

  /** three-vrm's rule, on a clone: raw = parentWorld⁻¹ · normalized · parentWorld · rest. */
  private poseImpostor(e: Entry, bones: BoneAngles): void {
    const tpl = this.readyTemplate(e.manifest);
    if (!tpl || !e.impostor) return;
    for (const [bone, b] of tpl.bones) {
      const node = e.impostor.nodes.get(bone);
      if (!node) continue;
      const a = bones[bone];
      if (!a) {
        node.quaternion.copy(b.rest);
        continue;
      }
      qa.setFromEuler(euler.set(a[0], a[1], a[2]));
      qb.copy(b.parentWorld).invert();
      node.quaternion.copy(qa).multiply(b.parentWorld).premultiply(qb).multiply(b.rest);
    }
  }

  private readonly ready = new Map<string, Template>();
  private readyTemplate(manifest: string): Template | undefined {
    const known = this.ready.get(manifest);
    if (known) return known;
    void this.templates.get(manifest)?.then((t) => this.ready.set(manifest, t));
    return undefined;
  }

  /** What an entry's current level should wear: changes when the outfit or the level does. */
  private outfitKey(e: Entry): string {
    return `${e.level ?? ''}:${e.kit ?? ''}:${JSON.stringify(e.outfit)}`;
  }

  private undress(e: Entry): void {
    for (const o of e.worn) o.removeFromParent();
    e.worn = [];
    e.wornItems = 0;
    e.dressed = undefined;
  }

  /** Items worn on the avatars now, all players together (S5.05). */
  dressedItems(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.wornItems;
    return n;
  }

  /** Puts an entry's outfit on its current level: one outfit at a time across the layer. */
  private dressUp(entity: number, e: Entry): void {
    if (this.dressing || !this.fetchItem) return;
    this.dressing = true;
    const key = this.outfitKey(e);
    const vrm = e.vrm!;
    void (async () => {
      const added: THREE.Object3D[] = [];
      try {
        const known = await Promise.all(
          e.outfit.map(async (w) => {
            try {
              return { w, m: await this.itemManifest(w.item) };
            } catch {
              this.itemFailures += 1;
              return undefined;
            }
          }),
        );
        const kept = resolveOutfit(known.filter((k): k is { w: Worn; m: ItemManifest } => k !== undefined).map((k) => ({ ...k, slot: k.m.slot, attach: k.m.attach })));
        const hidden = new Set<Region>();
        let items = 0;
        for (const { w, m } of kept) {
          try {
            if (m.slot === 'attachment' && m.attach) {
              const prop = (await this.prop(w.item)).clone();
              const node = (b: string): THREE.Object3D | undefined => vrm.humanoid.getRawBoneNode(b as Parameters<VRM['humanoid']['getRawBoneNode']>[0]) ?? undefined;
              const pivot = e.rest2 ? wearProp(prop, m.attach, node, e.rest2, e.info?.height && e.info.height > 0.3 ? e.info.height : 1.7, w.adjust) : undefined;
              if (pivot) {
                added.push(pivot);
                items += 1;
              }
            } else if (e.kit && m.fits[e.kit]) {
              const meshes = wearFit(await this.fit(w.item, e.kit), vrm.scene);
              if (!meshes) throw new Error('the fit does not match the body');
              vrm.scene.add(...meshes);
              added.push(...meshes);
              for (const r of m.hides) hidden.add(r);
              items += 1;
            }
          } catch {
            this.itemFailures += 1;
          }
        }
        // The level changed or the outfit did while this loaded: what was added comes off again.
        if (e.vrm !== vrm || this.outfitKey(e) !== key || this.entries.get(entity) !== e) {
          for (const o of added) o.removeFromParent();
          return;
        }
        this.undress(e);
        vrm.scene.traverse((o) => {
          const m = o as THREE.SkinnedMesh;
          if (m.isSkinnedMesh && m.name !== 'flatchat-fit') hideRegions(m, hidden);
        });
        e.worn = added;
        e.wornItems = items;
        e.dressed = key;
      } finally {
        this.dressing = false;
      }
    })();
  }

  private itemManifest(hash: string): Promise<ItemManifest> {
    let m = this.itemManifests.get(hash);
    if (!m) {
      m = this.fetchItem!(hash, 'manifest').then((r) => r.manifest);
      m.catch(() => this.itemManifests.delete(hash));
      this.itemManifests.set(hash, m);
    }
    return m;
  }

  private fit(hash: string, kit: BodyKit): Promise<FitTemplate> {
    const id = `${hash}:${kit}`;
    let t = this.fits.get(id);
    if (!t) {
      t = (async () => {
        const got = await this.fetchItem!(hash, kit);
        if (!got.bytes) throw new Error('no fit');
        return fitTemplate(await parseItemFile(this.renderer, got.bytes, 'fit'));
      })();
      t.catch(() => this.fits.delete(id));
      this.fits.set(id, t);
    }
    return t;
  }

  private prop(hash: string): Promise<THREE.Object3D> {
    let t = this.props.get(hash);
    if (!t) {
      t = (async () => {
        const got = await this.fetchItem!(hash, 'prop');
        if (!got.bytes) throw new Error('no prop');
        return parseItemFile(this.renderer, got.bytes, 'prop');
      })();
      t.catch(() => this.props.delete(hash));
      this.props.set(hash, t);
    }
    return t;
  }

  /** The layer's own state, for reports: a load under way, templates, and why loads failed. */
  status(): { busy: boolean; entries: number; templates: number; failed: number; lastError: string } {
    let failed = 0;
    for (const e of this.entries.values()) if (e.failed) failed += 1;
    return { busy: this.busy, entries: this.entries.size, templates: this.templates.size, failed, lastError: this.lastError };
  }
  private lastError = '';

  /** How many avatars are drawn at each level now. */
  counts(): Record<Level, number> {
    const out: Record<Level, number> = { lod0: 0, lod1: 0, lod2: 0, impostor: 0 };
    for (const e of this.entries.values()) if (e.level) out[e.level] += 1;
    return out;
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
    for (const t of this.templates.values()) void t.then((x) => disposeLevel(x.vrm)).catch(() => undefined);
    this.templates.clear();
    this.ready.clear();
    for (const t of this.fits.values()) void t.then((x) => x.parts.forEach((p) => p.geometry.dispose())).catch(() => undefined);
    for (const t of this.props.values()) void t.then((x) => x.traverse((o) => (o as THREE.Mesh).geometry?.dispose())).catch(() => undefined);
    this.fits.clear();
    this.props.clear();
    this.itemManifests.clear();
    this.animations.clear();
  }
}

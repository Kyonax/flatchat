// SPDX-License-Identifier: MPL-2.0
// Placeholder avatars (S1.09) until players bring their own (Stage 4): a capsule in a colour of
// their own, a bright visor that shows where they face, a ring above the head that lights while they
// speak, and their name above it. Bodies, visors and rings are instanced (three draw calls for
// everyone); a name is a sprite drawn as text onto a canvas, never markup, made only for the
// nearest players.
import { BODY } from '@flatchat/sim';
import * as THREE from 'three/webgpu';

export interface AvatarPose {
  entity: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  name: string;
  /** 0 to 1: how loud they are right now. */
  speaking: number;
  /** Hidden: the player's own body in first person. */
  hidden?: boolean;
  /** The player's height over the standard body's (S2.07); 1 when left out. */
  scale?: number;
  sitting?: boolean;
  /** Their own avatar is drawn (S4.05): no capsule, but the name and the speaking ring stay. */
  avatarDrawn?: boolean;
}

export type TagFactory = (name: string) => THREE.Sprite;

const CAPACITY = 256;
const TAG_RANGE = 25;
const TAG_LIMIT = 32;

/** A colour from the entity number: the same player keeps it while connected. */
export function colourOf(entity: number): THREE.Color {
  const hue = ((entity * 0.618_033_988_75) % 1 + 1) % 1;
  return new THREE.Color().setHSL(hue, 0.55, 0.55);
}

/** A name tag: the text drawn on a canvas, so a name is only ever pixels. */
export function canvasTag(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '600 36px system-ui, sans-serif';
  ctx.font = font;
  const width = Math.min(512, Math.ceil(ctx.measureText(name).width) + 32);
  canvas.width = width;
  canvas.height = 56;
  ctx.font = font;
  ctx.fillStyle = 'rgba(16,16,20,0.6)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, 56, 12);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, width / 2, 29, width - 16);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  sprite.scale.set((width / 56) * 0.28, 0.28, 1);
  return sprite;
}

export class CrowdView {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly visors: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly tags = new Map<number, { sprite: THREE.Sprite; name: string }>();
  private readonly makeTag: TagFactory | undefined;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(makeTag?: TagFactory) {
    this.makeTag = makeTag;
    const capsule = new THREE.CapsuleGeometry(BODY.radius, BODY.height - BODY.radius * 2, 4, 12);
    capsule.translate(0, BODY.height / 2, 0);
    this.bodies = new THREE.InstancedMesh(capsule, new THREE.MeshLambertMaterial({ color: 0xffffff }), CAPACITY);
    const visor = new THREE.BoxGeometry(0.34, 0.12, 0.12);
    visor.translate(0, BODY.eye, -BODY.radius + 0.02);
    this.visors = new THREE.InstancedMesh(visor, new THREE.MeshBasicMaterial({ color: 0xf9cd26 }), CAPACITY);
    const ring = new THREE.TorusGeometry(0.22, 0.035, 6, 24);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, BODY.height + 0.18, 0);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ color: 0x8bd5a0 }), CAPACITY);
    // The colour buffer exists before the first draw, so the shader is built with it.
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3).fill(1), 3);
    for (const mesh of [this.bodies, this.visors, this.rings]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** Draws everyone this frame. `from` is the camera's position, for choosing whose names to show. */
  update(avatars: readonly AvatarPose[], from: { x: number; z: number }): void {
    let n = 0;
    let speakers = 0;
    const scale = new THREE.Vector3(1, 1, 1);
    for (const a of avatars) {
      if (a.hidden || n >= CAPACITY) continue;
      const s = a.scale ?? 1;
      // A seated placeholder folds to about two thirds of its height.
      scale.set(s, a.sitting ? s * 0.68 : s, s);
      this.q.setFromAxisAngle(this.up, a.yaw);
      this.m.compose(new THREE.Vector3(a.x, a.y, a.z), this.q, scale);
      if (!a.avatarDrawn) {
        this.bodies.setMatrixAt(n, this.m);
        this.bodies.setColorAt(n, colourOf(a.entity));
        this.visors.setMatrixAt(n, this.m);
        n += 1;
      }
      if (a.speaking > 0.05) {
        const r = (0.8 + Math.min(1, a.speaking) * 0.6) * s;
        this.m.compose(new THREE.Vector3(a.x, a.y, a.z), this.q, new THREE.Vector3(r, scale.y, r));
        this.rings.setMatrixAt(speakers, this.m);
        speakers += 1;
      }
    }
    this.bodies.count = n;
    this.visors.count = n;
    this.rings.count = speakers;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.visors.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    this.updateTags(avatars, from);
  }

  private updateTags(avatars: readonly AvatarPose[], from: { x: number; z: number }): void {
    if (!this.makeTag) return;
    const near = avatars
      .filter((a) => !a.hidden)
      .map((a) => ({ a, d: Math.hypot(a.x - from.x, a.z - from.z) }))
      .filter((e) => e.d <= TAG_RANGE)
      .sort((p, q) => p.d - q.d)
      .slice(0, TAG_LIMIT);
    const keep = new Set(near.map((e) => e.a.entity));
    for (const [entity, tag] of this.tags) {
      if (!keep.has(entity)) {
        this.group.remove(tag.sprite);
        tag.sprite.material.map?.dispose();
        tag.sprite.material.dispose();
        this.tags.delete(entity);
      }
    }
    for (const { a } of near) {
      let tag = this.tags.get(a.entity);
      if (!tag || tag.name !== a.name) {
        if (tag) this.group.remove(tag.sprite);
        tag = { sprite: this.makeTag(a.name), name: a.name };
        this.tags.set(a.entity, tag);
        this.group.add(tag.sprite);
      }
      tag.sprite.position.set(a.x, a.y + (BODY.height + 0.45) * (a.scale ?? 1) * (a.sitting ? 0.7 : 1), a.z);
    }
  }

  get tagCount(): number {
    return this.tags.size;
  }
}

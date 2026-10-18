// SPDX-License-Identifier: Apache-2.0
// Screen overlays (S6.02, Q-M13, T-14, G-20): images shown on the screen, not in the world. Three
// kinds: an overlay a player wears on their own screen, at a screen point (as Second Life's HUD
// attachments are worn); one they also show on other players' screens, which each viewer allows
// person by person; and a world's own, set by its maker, on for everyone until a viewer switches
// them off. The viewer's choice always wins (T-14), and the safe-mode key clears every overlay at
// once. The format is a still PNG (the converter keeps the first frame of an animated one), at most
// 512 px a side, with a size, an opacity and a slow motion: nothing an overlay does can flash.
// Shared by the converter, the core, the world validator and the client.
import { imageSize } from './image-size.ts';

/** The screen points an overlay is worn at: the corners, the edges' middles and the centre. */
export const HUD_POINTS = ['top-left', 'top', 'top-right', 'left', 'centre', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
export type HudPoint = (typeof HUD_POINTS)[number];

/** How an overlay moves. Each cycle takes OVERLAY_LIMITS.periodS; a pulse fades only to half its
 *  opacity, so no motion comes near the three flashes a second that photosensitivity guidance sets. */
export const OVERLAY_MOTIONS = ['none', 'pulse', 'bob', 'spin'] as const;
export type OverlayMotion = (typeof OVERLAY_MOTIONS)[number];

/** Who sees a worn overlay: the wearer alone, or other players too (each with their consent). */
export const OVERLAY_AUDIENCES = ['self', 'everyone'] as const;
export type OverlayAudience = (typeof OVERLAY_AUDIENCES)[number];

export const OVERLAY_LIMITS = {
  /** The image: its longer side, and the upload. */
  side: 512,
  bytes: 1024 * 1024,
  /** Its size on the screen: its longer side as a share of the screen's height. */
  size: { min: 0.03, max: 0.5 },
  opacity: { min: 0.1, max: 1 },
  /** One cycle of a motion, in seconds. */
  periodS: 2,
  /** One wearer's overlays at once. */
  worn: 4,
  /** Another player's overlays on a viewer's screen: at most this big and this opaque, never at the
   *  centre (moved to the top), at most this many from everyone together, each shown for this long
   *  after it was put on. */
  others: { size: 0.2, opacity: 0.7, count: 3, showS: 10 },
  /** A world's overlays: at most this many, up to the whole screen, at most this opaque, their
   *  images at most this many px a side (a frame round the screen wants more than an item). */
  world: { count: 4, size: 1, opacity: 0.8, side: 1024 },
} as const;

/** How an overlay looks on the screen. */
export interface OverlayLook {
  hud: HudPoint;
  /** Its longer side as a share of the screen's height. */
  size: number;
  opacity: number;
  motion: OverlayMotion;
}

/** An overlay item as the platform keeps it: its image (re-encoded by the converter) and its look. */
export interface OverlayFit extends OverlayLook {
  /** The image: its SHA-256 and size, and its pixels. */
  file: string;
  bytes: number;
  width: number;
  height: number;
  audience: OverlayAudience;
}

/** Reads an overlay's look from a declaration (an item's or a world's), with every problem. */
export function readOverlayLook(d: Record<string, unknown>, where: 'item' | 'world'): { look: OverlayLook; problems: string[] } {
  const problems: string[] = [];
  const hud = d['hud'] ?? (where === 'world' ? 'centre' : undefined);
  if (typeof hud !== 'string' || !(HUD_POINTS as readonly string[]).includes(hud)) problems.push(`an overlay names its screen point: one of ${HUD_POINTS.join(', ')}`);
  const maxSize = where === 'world' ? OVERLAY_LIMITS.world.size : OVERLAY_LIMITS.size.max;
  const size = d['size'] ?? 0.15;
  if (typeof size !== 'number' || !(size >= OVERLAY_LIMITS.size.min && size <= maxSize)) problems.push(`an overlay's size is ${OVERLAY_LIMITS.size.min} to ${maxSize} of the screen's height`);
  const maxOpacity = where === 'world' ? OVERLAY_LIMITS.world.opacity : OVERLAY_LIMITS.opacity.max;
  const opacity = d['opacity'] ?? Math.min(1, maxOpacity);
  if (typeof opacity !== 'number' || !(opacity >= OVERLAY_LIMITS.opacity.min && opacity <= maxOpacity)) problems.push(`an overlay's opacity is ${OVERLAY_LIMITS.opacity.min} to ${maxOpacity}`);
  const motion = d['motion'] ?? 'none';
  if (typeof motion !== 'string' || !(OVERLAY_MOTIONS as readonly string[]).includes(motion)) problems.push(`an overlay's motion is one of ${OVERLAY_MOTIONS.join(', ')}`);
  return { look: { hud: hud as HudPoint, size: size as number, opacity: opacity as number, motion: motion as OverlayMotion }, problems };
}

/** Checks an overlay image: a PNG within the limits (`side`: an item's, or a world's). Empty when
 *  it passes. The client checks a world's images with it too: a host is not trusted. */
export function overlayImageProblems(bytes: Uint8Array, side: number = OVERLAY_LIMITS.side): string[] {
  if (bytes.length > OVERLAY_LIMITS.bytes) return [`an overlay's image is ${OVERLAY_LIMITS.bytes / 1048576} MB at most`];
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const size = png ? imageSize(bytes) : undefined;
  if (!size) return ["an overlay's image is a PNG"];
  if (size.width < 1 || size.height < 1 || Math.max(size.width, size.height) > side) return [`an overlay's image is ${size.width}×${size.height}: ${side} px a side at most`];
  return [];
}

/** Checks an overlay fit from the core before the client trusts it. */
export function checkOverlayFit(value: unknown): OverlayFit {
  const f = value as OverlayFit;
  if (typeof f !== 'object' || f === null || typeof f.file !== 'string' || !/^[0-9a-f]{64}$/.test(f.file)) throw new Error('an overlay names its image');
  const { problems } = readOverlayLook(f as unknown as Record<string, unknown>, 'item');
  if (problems.length) throw new Error(problems[0]);
  if (!(OVERLAY_AUDIENCES as readonly string[]).includes(f.audience)) throw new Error("an overlay's audience is self or everyone");
  if (!(f.width >= 1 && f.width <= OVERLAY_LIMITS.side && f.height >= 1 && f.height <= OVERLAY_LIMITS.side)) throw new Error("an overlay's image is out of range");
  return f;
}

/** Whose an overlay on a viewer's screen is. */
export type OverlayWhose = 'mine' | 'other' | 'world';

/** What a viewer chose about overlays (the client's settings). */
export interface OverlaySettings {
  /** The viewer's own worn overlays. */
  mine: boolean;
  /** Worlds' overlays: on until the viewer switches them off (T-14, Q-E6). */
  world: boolean;
  /** The accounts whose overlays the viewer allowed, person by person (Q-M13's consent). */
  allowed: readonly string[];
}

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = { mine: true, world: true, allowed: [] };

/** Whether an overlay shows on a viewer's screen (S6.02, T-14): the safe-mode key clears all of
 *  them; the viewer's own show unless switched off; a world's show unless switched off; another
 *  player's only when the wearer shows it to everyone, the viewer allowed that person, the person is
 *  not hidden or blocked, and it was put on less than OVERLAY_LIMITS.others.showS ago. */
export function overlayVisible(o: {
  whose: OverlayWhose;
  settings: OverlaySettings;
  safeMode: boolean;
  /** Another player's: their account, the overlay's audience, whether the viewer hides them, and
   *  how long ago it was put on (seconds). */
  account?: string | undefined;
  audience?: OverlayAudience | undefined;
  hidden?: boolean | undefined;
  ageS?: number | undefined;
}): boolean {
  if (o.safeMode) return false;
  if (o.whose === 'mine') return o.settings.mine;
  if (o.whose === 'world') return o.settings.world;
  if (o.audience !== 'everyone' || o.hidden || o.account === undefined) return false;
  if (!o.settings.allowed.includes(o.account)) return false;
  return (o.ageS ?? 0) < OVERLAY_LIMITS.others.showS;
}

/** An overlay's look on a viewer's screen, within the viewer's caps for whose it is. */
export function overlayShown(look: OverlayLook, whose: OverlayWhose): OverlayLook {
  if (whose === 'world') return { ...look, size: Math.min(look.size, OVERLAY_LIMITS.world.size), opacity: Math.min(look.opacity, OVERLAY_LIMITS.world.opacity) };
  if (whose === 'mine') return { ...look, size: Math.min(look.size, OVERLAY_LIMITS.size.max), opacity: Math.min(look.opacity, OVERLAY_LIMITS.opacity.max) };
  return { ...look, hud: look.hud === 'centre' ? 'top' : look.hud, size: Math.min(look.size, OVERLAY_LIMITS.others.size), opacity: Math.min(look.opacity, OVERLAY_LIMITS.others.opacity) };
}

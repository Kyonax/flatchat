// SPDX-License-Identifier: MPL-2.0
// FlatChat's mark (S6.07): a square speech bubble with a stepped tail and three square dots on a
// 16-unit grid, squares only (the Kyonax HUD's law: no rounded corners). One list of squares for the
// interface's mark (ui/LogoMark.vue) and the program's icon (scripts/icon.ts). The name beside it is
// a codename's (README): the mark carries no letters, so it outlives the name. Pure.

/** The grid the squares sit on. */
export const LOGO_GRID = 16;
/** FlatChat's accent, the theme's --accent (oklch(74% 0.19 315)) in sRGB; and the brightest ink. */
export const LOGO_ACCENT = '#d780fc';
export const LOGO_BRIGHT = '#ffffff';

export interface LogoRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The bubble in the accent, the dots in the brightest ink. */
  ink: 'accent' | 'bright';
}

export const LOGO_RECTS: readonly LogoRect[] = [
  // The bubble: top, bottom, left and right.
  { x: 1, y: 1, w: 14, h: 2, ink: 'accent' },
  { x: 1, y: 9, w: 14, h: 2, ink: 'accent' },
  { x: 1, y: 3, w: 2, h: 6, ink: 'accent' },
  { x: 13, y: 3, w: 2, h: 6, ink: 'accent' },
  // The tail, stepping down at the left.
  { x: 3, y: 11, w: 4, h: 2, ink: 'accent' },
  { x: 3, y: 13, w: 2, h: 2, ink: 'accent' },
  // Three dots: someone is talking.
  { x: 4, y: 5, w: 2, h: 2, ink: 'bright' },
  { x: 7, y: 5, w: 2, h: 2, ink: 'bright' },
  { x: 10, y: 5, w: 2, h: 2, ink: 'bright' },
];

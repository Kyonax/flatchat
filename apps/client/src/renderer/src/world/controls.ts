// SPDX-License-Identifier: MPL-2.0
// Keys, mouse buttons and mouse look, turned into actions through the player's bindings (S1.09).
// Pure: the page feeds it events, the world polls it every frame; no DOM here, so it is tested in
// plain Node. Bindings are layout-free codes (KeyboardEvent.code), so WASD stays where it is on
// any keyboard layout.
import { type Action, actionFor, type Bindings } from '../../../shared/settings';

/** The look's pitch is held short of straight up or down. */
export const PITCH_LIMIT = 1.45;

export class Controls {
  keys: Bindings;
  /** Degrees of turn per 100 pixels of mouse movement. */
  sensitivity: number;
  invertY: boolean;
  yaw = 0;
  pitch = 0;
  private readonly down = new Set<string>();
  private readonly edges = new Set<Action>();

  constructor(keys: Bindings, sensitivity: number, invertY: boolean) {
    this.keys = keys;
    this.sensitivity = sensitivity;
    this.invertY = invertY;
  }

  /** A key or button went down; returns its action, if it has one. Repeats do not count again. */
  press(code: string): Action | undefined {
    const action = actionFor(this.keys, code);
    if (!this.down.has(code) && action) this.edges.add(action);
    this.down.add(code);
    return action;
  }

  release(code: string): void {
    this.down.delete(code);
  }

  /** Lets go of everything: the window lost focus or the pointer was released. */
  clear(): void {
    this.down.clear();
    this.edges.clear();
  }

  held(action: Action): boolean {
    for (const code of this.keys[action]) if (this.down.has(code)) return true;
    return false;
  }

  /** Whether the action was pressed since the last call (each press counts once). */
  took(action: Action): boolean {
    const had = this.edges.has(action);
    this.edges.delete(action);
    return had;
  }

  look(dx: number, dy: number): void {
    const k = ((this.sensitivity / 100) * Math.PI) / 180;
    this.yaw -= dx * k;
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    this.pitch -= dy * k * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  /** The movement axes: forward minus back, right minus left. */
  axes(): { forward: number; right: number } {
    return { forward: (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0), right: (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0) };
  }
}

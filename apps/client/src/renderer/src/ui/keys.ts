// SPDX-License-Identifier: MPL-2.0
// What to call a key on screen. Bindings store layout-free codes (KeyW is where W sits on a US
// keyboard); the label shows what that key prints on this player's layout when Chromium knows it.

type Translate = (key: string) => string;

let layout: Map<string, string> | undefined;

/** Reads the keyboard layout once (Chromium's Keyboard API); without it, labels come from the codes. */
export async function loadLayout(): Promise<void> {
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
  try {
    layout = keyboard ? new Map(await keyboard.getLayoutMap()) : undefined;
  } catch {
    layout = undefined;
  }
}

const NAMED = new Set(['Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'CapsLock', 'Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4']);

export function keyLabel(code: string, t: Translate): string {
  if (NAMED.has(code)) return t(`keys.${code}`);
  const printed = layout?.get(code);
  if (printed) return printed.toUpperCase();
  return code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
}

/** The binding code of a mouse button event, as settings store it. */
export function mouseCode(button: number): string {
  return `Mouse${Math.min(4, Math.max(0, button))}`;
}

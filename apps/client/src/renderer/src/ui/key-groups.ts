// SPDX-License-Identifier: MPL-2.0
// The keys help's groups (S6.07): every action once, in the order a new player needs them.
import type { Action } from '../../../shared/settings';

export const KEY_GROUPS: ReadonlyArray<{ id: 'moving' | 'talking' | 'expressing' | 'always'; actions: readonly Action[] }> = [
  { id: 'moving', actions: ['forward', 'back', 'left', 'right', 'run', 'jump', 'fly', 'down', 'sit', 'goto', 'teleport', 'view'] },
  { id: 'talking', actions: ['chat', 'talk', 'mute', 'earmuffs', 'people'] },
  { id: 'expressing', actions: ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'hands', 'emotes', 'outfits'] },
  { id: 'always', actions: ['menu', 'help', 'stats'] },
];

// SPDX-License-Identifier: MPL-2.0
// The voice test's plugin (S3.08): a player's range and gain by name.
import type { PluginHooks } from '../../../../src/plugins.ts';

export default function setup(): PluginHooks {
  return {
    on_voice_settings: (p) => (p.name === 'Whisper' ? { range: 5 } : p.name === 'Shout' ? { range: 80, gain: 2 } : undefined),
  };
}

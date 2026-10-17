// SPDX-License-Identifier: MPL-2.0
import type { HostApi, PluginHooks } from '../../../../src/plugins.ts';

// Tries to kick everyone without asking for the moderation permission.
export default function setup(host: HostApi): PluginHooks {
  return { on_join: (p) => host.kick(p.entity, 'no reason') };
}

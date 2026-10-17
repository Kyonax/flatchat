// SPDX-License-Identifier: MPL-2.0
import type { PluginHooks } from '../../../../src/plugins.ts';

export default function setup(): PluginHooks {
  return { on_join_request: (r) => (r.tester ? { admit: true } : { admit: false, reason: 'testers only today' }) };
}

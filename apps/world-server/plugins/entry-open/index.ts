// SPDX-License-Identifier: MPL-2.0
// Entry rule (S3.05): open to anyone with the world's id (Q-L9).
import type { PluginHooks } from '@flatchat/world-server/plugins';

export default function setup(): PluginHooks {
  return { on_join_request: () => ({ admit: true }) };
}

// SPDX-License-Identifier: MPL-2.0
// The plugin loader's test plugin: a greeting with a visit count, a /roll command and a chat filter.
import type { HostApi, PluginHooks } from '../../../../src/plugins.ts';

export default function setup(host: HostApi): PluginHooks {
  return {
    on_join(player) {
      const visits = Number(host.store.get(player.account) ?? '0') + 1;
      host.store.set(player.account, String(visits));
      host.say(`${String(host.settings['greeting'])}, ${player.name} (visit ${visits})`, player.entity);
    },
    on_command(player, name, args) {
      if (name === 'roll') host.say(`${player.name} rolled ${args[0] ?? 'nothing'}`);
    },
    on_chat(_player, text) {
      return text.includes('spoiler') ? { drop: true } : { text: text.replace(/darn/g, 'd**n') };
    },
  };
}

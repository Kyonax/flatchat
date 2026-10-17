// SPDX-License-Identifier: MPL-2.0
// The loader's async test plugin: its setup waits before answering; its on_join greets and then
// rejects; its entry rule answers with a promise for one name, which host interface 1 refuses.
import type { HostApi, PluginHooks, Verdict } from '../../../../src/plugins.ts';

export default async function setup(host: HostApi): Promise<PluginHooks> {
  await new Promise((r) => setTimeout(r, 10));
  return {
    on_join_request: (r) => (r.name === 'Async' ? (Promise.resolve({ admit: true }) as unknown as Verdict) : { admit: true }),
    async on_join(player) {
      host.say(`ready for ${player.name}`, player.entity);
      await Promise.resolve();
      throw new Error(`nothing more for ${player.name}`);
    },
  };
}

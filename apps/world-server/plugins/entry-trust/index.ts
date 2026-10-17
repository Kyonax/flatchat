// SPDX-License-Identifier: MPL-2.0
// Entry rule (S3.05): a minimum trust level (0 to 7, the core's levels, S3.09), or, with
// testers_only, only accounts the owner made testers (the closed test).
import type { HostApi, PluginHooks } from '@flatchat/world-server/plugins';

export default function setup(host: HostApi): PluginHooks {
  const raw = Number(host.settings['min_trust'] ?? 1);
  const min = Number.isFinite(raw) ? Math.min(7, Math.max(0, Math.floor(raw))) : 1;
  const testersOnly = host.settings['testers_only'] === true;
  return {
    on_join_request: (r) => {
      if (testersOnly) return r.tester ? { admit: true } : { admit: false, reason: 'This world is open to testers only.' };
      return r.trust >= min || r.tester ? { admit: true } : { admit: false, reason: `This world asks for trust level ${min} or more.` };
    },
  };
}

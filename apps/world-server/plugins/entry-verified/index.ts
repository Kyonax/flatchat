// SPDX-License-Identifier: MPL-2.0
// Entry rule (S3.05): a verified email and a minimum account age (Q-L9), from the connect token's
// facts; the setting min_account_days (0 to 3650, default 7).
import type { HostApi, PluginHooks } from '@flatchat/world-server/plugins';

export default function setup(host: HostApi): PluginHooks {
  const raw = Number(host.settings['min_account_days'] ?? 7);
  const days = Number.isFinite(raw) ? Math.min(3650, Math.max(0, Math.floor(raw))) : 7;
  return {
    on_join_request: (r) => {
      if (!r.emailVerified) return { admit: false, reason: 'This world asks for a verified email.' };
      if (r.ageDays < days) return { admit: false, reason: `This world asks for an account at least ${days} days old.` };
      return { admit: true };
    },
  };
}

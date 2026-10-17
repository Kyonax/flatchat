// SPDX-License-Identifier: MPL-2.0
// Where the client finds the core unless told otherwise (--core=URL, or the settings' core field).
// The core runs on the owner's PC behind a Cloudflare Tunnel on a kyonax.com subdomain (DR-16);
// which subdomain is open question OQ-27, answered here by the agents' default until the owner
// decides, and served once kyonax.com's DNS has moved to Cloudflare (OQ-8).
export const DEFAULT_CORE = 'https://core.kyonax.com';

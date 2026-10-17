// SPDX-License-Identifier: MPL-2.0
// What a store scope may hold (S2.08), apart from the store so the world server can apply the same
// limits without loading node:sqlite (the client runs the world server for offline play).

/** Values a scope may hold: 64 KB each, 1,000 keys each, keys of 128 characters at most. */
export const STORE_LIMITS = { value: 64 * 1024, keys: 1000, key: 128 };

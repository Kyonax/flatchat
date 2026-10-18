// SPDX-License-Identifier: MPL-2.0
// Where the self-update looks (S7.01) and the key it trusts: the owner's Ed25519 public key, its raw
// 32 bytes in base64, made with `node apps/client/scripts/update-keygen.ts` on his own machine (the
// private key never leaves it). Empty: the client never updates itself (OQ-34).
export const UPDATE_FEED = 'https://kyonax.com/flatchat/updates/';
export const UPDATE_PUBLIC_KEY = '';

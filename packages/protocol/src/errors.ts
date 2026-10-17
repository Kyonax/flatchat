// SPDX-License-Identifier: Apache-2.0
// The one error the codecs throw. Its code says what was wrong, so a world server can count bad
// packets by kind and every implementation of the protocol can be tested against the same codes
// (golden/invalid.json).

export const PROTOCOL_ERROR_CODES = [
  'truncated', // the bytes ended before the message did
  'trailing', // bytes left over after the message
  'padding', // a padding bit was not zero
  'bad-varint', // a length or count written with more bytes than it needs, or too long
  'unknown-type', // no message has this type number
  'wrong-direction', // a message the sender is not allowed to send
  'too-long', // a string, byte string, list or message over its limit
  'bad-utf8', // a string that is not valid UTF-8
  'out-of-range', // a number or enum value outside what the field allows
  'bad-value', // a value of the wrong kind, given to an encoder or read from JSON
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

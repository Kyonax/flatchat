# Protocol

The message schema, the bit-packed codecs, the connect-token format and the version handshake, shared by the client, the world server, the bots and the core. It runs unchanged in Node.js and in the client's renderer. The wire format is specified in [docs/protocol.md](../../docs/protocol.md).

- Licence: Apache-2.0 ([LICENSE](LICENSE))
- Status: version 1 (Stage 0: S0.06 built version 0, measured with 200 bots in S0.07; S0.08 added the voice frames' `start` bit).

```ts
import { decodeMessage, encodeMessage, ProtocolError } from '@flatchat/protocol';

const bytes = encodeMessage({ type: 'say', text: 'hola' });
try {
  const message = decodeMessage(bytes, 'client'); // a server reading what a client sent
} catch (err) {
  if (err instanceof ProtocolError) console.log(err.code); // drop the packet
}
```

| File | What |
|---|---|
| `src/schema.ts` | The messages, the cell block and the connect token's layout; `PROTOCOL_VERSION` |
| `src/codec.ts`, `src/bits.ts` | The codecs and the bit writer and reader |
| `src/messages.ts` | `encodeMessage`, `decodeMessage`, cell blocks, JSON forms |
| `src/token.ts` | `sealToken` (the core), `openToken` (a world server), AES-256-GCM through Web Crypto |
| `src/handshake.ts` | `versionPolicy`, `checkVersion` |
| `src/golden.ts` | `runGolden()`, exported as `@flatchat/protocol/golden` |
| `golden/` | The golden packets every implementation must pass |
| `scripts/golden.ts` | `npm run golden -w @flatchat/protocol [-- --write]`: checks or writes the golden bytes, and refuses new bytes without a new version |

`npm test -w @flatchat/protocol` runs the tests; `npm run typecheck -w @flatchat/protocol` checks the code twice, once with Node's types and once with only the browser's.

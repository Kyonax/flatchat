// SPDX-License-Identifier: MPL-2.0
// A link inside one program (S2.13, offline mode): the client's main process runs the world server
// and its page joins over Electron's IPC, so playing alone needs no network, no core and no native
// module. Messages keep their channel (reliable or unreliable) and arrive in order, which suits
// both channels on one machine.
import type { Channel } from '@flatchat/protocol';
import { emptyStats, type Link, type LinkStats, type ServerTransport } from './types.ts';

let nextLocalId = 1_000_000;

export class LocalLink implements Link {
  readonly id = nextLocalId++;
  readonly transport = 'local' as const;
  readonly remote = 'this program';
  private readonly deliver: (channel: Channel, bytes: Uint8Array) => void;
  private readonly ended: (reason: string) => void;
  private messageHandler: ((channel: Channel, bytes: Uint8Array) => void) | undefined;
  private closeHandler: (reason: string) => void = () => {};
  private closed = false;
  private readonly counters: LinkStats = emptyStats();

  /** `deliver` takes what the world sends the page; `ended` hears that the link closed. */
  constructor(deliver: (channel: Channel, bytes: Uint8Array) => void, ended: (reason: string) => void) {
    this.deliver = deliver;
    this.ended = ended;
  }

  /** What the page sent. */
  receive(channel: Channel, bytes: Uint8Array): void {
    if (this.closed) return;
    this.counters.receivedBytes[channel] += bytes.length;
    this.counters.receivedMessages[channel] += 1;
    this.messageHandler?.(channel, bytes);
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (this.closed) return;
    this.counters.sentBytes[channel] += bytes.length;
    this.counters.sentMessages[channel] += 1;
    this.deliver(channel, bytes);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler(reason);
    this.ended(reason);
  }

  onMessage(handler: (channel: Channel, bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  stats(): LinkStats {
    return structuredClone(this.counters);
  }
}

/** The world server's side: each `connect` is a new player. */
export class LocalTransport implements ServerTransport {
  readonly name = 'local' as const;
  readonly address = { local: 'this program' };
  private handler: ((link: Link) => void) | undefined;

  onLink(handler: (link: Link) => void): void {
    this.handler = handler;
  }

  connect(deliver: (channel: Channel, bytes: Uint8Array) => void, ended: (reason: string) => void = () => {}): LocalLink {
    const link = new LocalLink(deliver, ended);
    this.handler?.(link);
    return link;
  }

  async close(): Promise<void> {}
}

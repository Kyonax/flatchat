// SPDX-License-Identifier: MPL-2.0
// The transport seam. A Link is one connected peer with the protocol's two channels
// (docs/protocol.md): reliable (ordered, retransmitted) and unreliable (unordered, never
// retransmitted). The world server and the bots see only this interface, so the two transports
// spike S0.07 compares (DR-07) swap freely: WebRTC data channels and raw UDP with our own
// encryption.
import type { Channel } from '@flatchat/protocol';

/** `local`: inside one program, the client's offline mode (S2.13). */
export type TransportName = 'udp' | 'rtc' | 'local';

export interface LinkStats {
  /** Application bytes and messages, per channel and direction. */
  sentBytes: Record<Channel, number>;
  sentMessages: Record<Channel, number>;
  receivedBytes: Record<Channel, number>;
  receivedMessages: Record<Channel, number>;
  /** Messages the transport would not take (closed, or its send queue full). */
  dropped: number;
  /** Raw UDP only: datagrams and their bytes as sent and received, before IP and UDP headers. */
  datagramsSent?: number;
  datagramBytesSent?: number;
  datagramsReceived?: number;
  datagramBytesReceived?: number;
  /** Raw UDP only: reliable segments sent again after a timeout. */
  retransmits?: number;
}

export interface Link {
  readonly id: number;
  readonly transport: TransportName;
  /** The peer's address as the transport sees it. */
  readonly remote: string;
  send(channel: Channel, bytes: Uint8Array): void;
  /** Closes the link; the close handler runs once, with this reason. */
  close(reason?: string): void;
  onMessage(handler: (channel: Channel, bytes: Uint8Array) => void): void;
  onClose(handler: (reason: string) => void): void;
  stats(): LinkStats;
}

export interface ServerTransport {
  readonly name: TransportName;
  /** How clients reach it, for the ready line. */
  readonly address: Record<string, string | number>;
  /** Called with each new link, once it can carry both channels. */
  onLink(handler: (link: Link) => void): void;
  close(): Promise<void>;
}

export function emptyStats(): LinkStats {
  return {
    sentBytes: { reliable: 0, unreliable: 0 },
    sentMessages: { reliable: 0, unreliable: 0 },
    receivedBytes: { reliable: 0, unreliable: 0 },
    receivedMessages: { reliable: 0, unreliable: 0 },
    dropped: 0,
  };
}

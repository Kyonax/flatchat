// SPDX-License-Identifier: MPL-2.0
// The transports, for the world server and for programs that connect to it (the bots, and later
// the client's host and offline modes): raw UDP with our own encryption, and WebRTC data channels.
export { connectRtc, RtcLink, type RtcConnectOptions, RtcServer, type RtcServerOptions } from './rtc.ts';
export type { Link, LinkStats, ServerTransport, TransportName } from './types.ts';
export { connectUdp, type UdpConnectOptions, UdpServer, type UdpServerOptions, UdpSession } from './udp.ts';

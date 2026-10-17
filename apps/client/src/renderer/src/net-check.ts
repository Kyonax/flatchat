// SPDX-License-Identifier: MPL-2.0
// The smoke test's network check: the renderer joins a real world server over WebRTC data channels
// with Chromium's own RTCPeerConnection (DR-07), as the game will (net/connection.ts), waits for
// its spawn, sends one pose and waits for the snapshot that acknowledges it, then leaves. The main
// process does the signaling and allows only local world servers (src/main/signal.ts).
import { fromHex } from '@flatchat/protocol';
import { WorldConnection } from './net/connection';

export interface NetCheck {
  ok: boolean;
  transport: 'rtc';
  /** From creating the connection to welcome. */
  joinMs?: number;
  entity?: number;
  snapshots: number;
  error?: string;
}

export async function checkJoin(signalUrl: string, tokenHex: string): Promise<NetCheck> {
  const result: NetCheck = { ok: false, transport: 'rtc', snapshots: 0 };
  let conn: WorldConnection | undefined;
  try {
    const started = performance.now();
    conn = await WorldConnection.join({ signalUrl, token: fromHex(tokenHex) });
    result.joinMs = Math.round(performance.now() - started);
    result.entity = conn.entity;
    conn.send({ type: 'pose', seq: 1, position: conn.spawn!.position, yaw: 0, look: 0, stance: 'standing' });
    await conn.next('snapshot', (s) => s.ack === 1);
    result.snapshots = conn.stats().received['snapshot'] ?? 0;
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    conn?.close('smoke test over');
  }
  return result;
}

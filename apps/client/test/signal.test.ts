// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { signalTarget } from '../src/main/signal';

describe('which world servers the client may signal to', () => {
  it('allows this machine and the local network, at /rtc only', () => {
    for (const ok of ['http://127.0.0.1:7779/rtc', 'http://192.168.40.3:7779/rtc', 'https://10.0.0.2:8443/rtc', 'http://172.20.1.1:7779/rtc', 'http://100.96.182.24:7779/rtc']) {
      expect(signalTarget(ok)?.href).toBe(new URL(ok).href);
    }
  });

  it('refuses public addresses, names, other paths, credentials and non-strings', () => {
    for (const bad of ['http://203.0.113.5:7779/rtc', 'http://example.com/rtc', 'http://127.0.0.1:7779/admin', 'http://user:pw@127.0.0.1:7779/rtc', 'http://127.0.0.1:7779/rtc?x=1', 'file:///etc/passwd', 'http://172.32.0.1/rtc', 'http://100.128.0.1:7779/rtc', 42, undefined]) {
      expect(signalTarget(bad)).toBeUndefined();
    }
  });
});

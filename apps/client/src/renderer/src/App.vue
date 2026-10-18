<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { checkJoin, type NetCheck } from './net-check';
import { checkProtocol, type ProtocolCheck } from './protocol-check';
import { startScene, type BenchOptions, type SceneStats } from './scene';
import { runConvertedCrowd } from './crowd/converted';
import { runCrowd } from './crowd/crowd';
import LoungeView from './lounge/LoungeView.vue';
import ClientApp from './ui/ClientApp.vue';
import { runVoiceLoad } from './voice/load-test';
import { runVoiceTest } from './voice/voice-test';

const canvas = ref<HTMLCanvasElement | null>(null);
const stats = ref<SceneStats | null>(null);
const failure = ref<string | null>(null);
const benchLine = ref<string | null>(null);
const versions = window.flatchat?.versions;
let stop: (() => void) | undefined;

// The main process picks the mode through the query string: ?smoke=1, or ?bench=SECONDS&size=WxH.
const params = new URLSearchParams(location.search);
const smoke = params.has('smoke');
const benchSeconds = Number(params.get('bench'));
const [benchWidth = 1280, benchHeight = 720] = (params.get('size') ?? '1280x720').split('x').map(Number);
const bench: BenchOptions | undefined =
  benchSeconds > 0
    ? {
        seconds: benchSeconds,
        width: benchWidth,
        height: benchHeight,
        onDone: (report) => {
          benchLine.value = `Bench done: ${report.summary.avgFps.toFixed(1)} fps average`;
          void window.flatchat?.benchReport(report);
        },
      }
    : undefined;
// The smoke test also runs the protocol's golden packets through this bundle, and with ?join and
// ?token joins that world server over WebRTC data channels.
const protocolCheck: Promise<ProtocolCheck> | undefined = smoke ? checkProtocol() : undefined;
const joinUrl = params.get('join');
const joinToken = params.get('token');
const netCheck: Promise<NetCheck | undefined> = smoke && joinUrl && joinToken ? checkJoin(joinUrl, joinToken) : Promise.resolve(undefined);
const checks = (): Promise<{ protocol: ProtocolCheck | undefined; net?: NetCheck }> =>
  Promise.all([protocolCheck, netCheck]).then(([protocol, net]) => ({ protocol, ...(net ? { net } : {}) }));

// Spike S0.08's voice test: ?voice=SECONDS with ?join, ?token (the speaker) and ?token2 (the listener).
const voiceSeconds = Number(params.get('voice'));
const loadSeconds = Number(params.get('voiceload'));
if (loadSeconds > 0) void runVoiceLoad(loadSeconds).then((report) => window.flatchat?.voiceReport(report));
if (voiceSeconds > 0 && joinUrl && joinToken && params.get('token2')) {
  void runVoiceTest(joinUrl, joinToken, params.get('token2')!, voiceSeconds).then((report) => window.flatchat?.voiceReport(report));
}

// Spike S0.09's crowd bench: ?crowd=SECONDS with the crowd's make-up; it draws instead of the greybox.
const crowdSeconds = Number(params.get('crowd'));
const crowdLine = ref<string | null>(null);
const num = (name: string, fallback: number): number => {
  const n = Number(params.get(name));
  return params.has(name) && Number.isFinite(n) ? n : fallback;
};

// The converted crowd's tier (S4.12): that tier's viewer policy as it ships.
const tierParam = params.get('tier');

// Spike S0.08's voice lounge: ?lounge=URL&token=HEX shows the lounge instead of the scene.
const loungeUrl = params.get('lounge');
const loungeToken = params.get('token');

// No measuring mode in the query: the app itself (sign-in, the worlds).
const appMode = !smoke && !(benchSeconds > 0) && !(crowdSeconds > 0) && !loungeUrl && !(voiceSeconds > 0) && !(loadSeconds > 0);

onMounted(async () => {
  if (loungeUrl || appMode) return;
  if (!canvas.value) return;
  if (crowdSeconds > 0 && params.get('converted') === '1') {
    const report = await runConvertedCrowd(canvas.value, {
      seconds: crowdSeconds,
      width: benchWidth,
      height: benchHeight,
      present: num('present', 200),
      inView: num('inview', 55),
      full: num('full', 12),
      lower: num('lod', 20),
      springs: num('springs', 6),
      ...(tierParam === 'low' || tierParam === 'medium' || tierParam === 'high' ? { tier: tierParam } : {}),
      onProgress: (line) => {
        crowdLine.value = line;
      },
    });
    crowdLine.value = report['error'] ? `Crowd failed: ${String(report['error'])}` : 'Converted crowd done';
    await window.flatchat?.crowdReport(report);
    return;
  }
  if (crowdSeconds > 0) {
    const report = await runCrowd(canvas.value, {
      seconds: crowdSeconds,
      width: benchWidth,
      height: benchHeight,
      full: num('full', 12),
      lod: num('lod', 20),
      present: num('present', 55),
      springs: num('springs', 6),
      swapSeconds: num('swap', 15),
      textureMB: num('texturemb', 16),
      lodRatio: num('lodratio', 0.3),
      merge: num('merge', 1) === 1,
      onProgress: (line) => {
        crowdLine.value = line;
      },
    });
    crowdLine.value = report.error ? `Crowd failed: ${report.error}` : `Crowd done: p95 ${report.summary.p95Ms} ms`;
    await window.flatchat?.crowdReport(report);
    return;
  }
  // The count is frames drawn; the screen still shows at most its refresh rate, unevenly paced.
  if (bench) benchLine.value = `Bench: ${bench.seconds} s at ${bench.width}×${bench.height}, no frame-rate cap (fps = frames drawn, not shown)`;
  try {
    stop = await startScene(canvas.value, {
      onStats: (s) => {
        stats.value = s;
      },
      ...(smoke ? { onSmoke: (report) => void checks().then((c) => window.flatchat?.smokeReport({ ...report, ...c })) } : {}),
      ...(bench ? { bench } : {}),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failure.value = error;
    if (smoke) void checks().then((c) => window.flatchat?.smokeReport({ backend: 'none', error, ...c }));
    if (bench) void window.flatchat?.benchReport({ backend: 'none', error });
  }
});

onBeforeUnmount(() => stop?.());
</script>

<template>
  <ClientApp v-if="appMode" />
  <LoungeView
    v-else-if="loungeUrl && loungeToken"
    :url="loungeUrl"
    :token="loungeToken"
  />
  <canvas
    v-if="!loungeUrl && !appMode"
    ref="canvas"
    class="view"
  />
  <div
    v-if="!loungeUrl && !appMode"
    class="hud"
  >
    <div><strong>FlatChat</strong> · {{ crowdSeconds > 0 ? 'spike S0.09: the crowd bench' : 'Stage 0 blank client' }}</div>
    <div v-if="stats">
      {{ stats.backend }} · {{ stats.fps.toFixed(0) }} fps<span v-if="stats.adapter"> · {{ stats.adapter }}</span>
    </div>
    <div v-if="crowdLine">
      {{ crowdLine }}
    </div>
    <div v-if="benchLine">
      {{ benchLine }}
    </div>
    <div
      v-if="failure"
      class="failure"
    >
      {{ failure }}
    </div>
    <div v-if="versions">
      Electron {{ versions.electron }} · Chromium {{ versions.chrome }} · Node {{ versions.node }}
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: #101014;
}

.view {
  display: block;
  width: 100%;
  height: 100%;
}

.hud {
  position: fixed;
  top: 12px;
  left: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgb(0 0 0 / 0.5);
  color: #e8e8ea;
  font: 13px/1.5 system-ui, sans-serif;
  pointer-events: none;
}

.failure {
  color: #ff8a80;
}
</style>

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { startScene, type BenchOptions, type SceneStats } from './scene';

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

onMounted(async () => {
  if (!canvas.value) return;
  if (bench) benchLine.value = `Bench: ${bench.seconds} s at ${bench.width}×${bench.height}, no frame-rate cap`;
  try {
    stop = await startScene(canvas.value, {
      onStats: (s) => {
        stats.value = s;
      },
      ...(smoke ? { onSmoke: (report) => void window.flatchat?.smokeReport(report) } : {}),
      ...(bench ? { bench } : {}),
    });
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
    if (smoke) void window.flatchat?.smokeReport({ backend: 'none', error: failure.value });
    if (bench) void window.flatchat?.benchReport({ backend: 'none', error: failure.value });
  }
});

onBeforeUnmount(() => stop?.());
</script>

<template>
  <canvas
    ref="canvas"
    class="view"
  />
  <div class="hud">
    <div><strong>FlatChat</strong> · Stage 0 blank client</div>
    <div v-if="stats">
      {{ stats.backend }} · {{ stats.fps.toFixed(0) }} fps<span v-if="stats.adapter"> · {{ stats.adapter }}</span>
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

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { startScene, type SceneStats } from './scene';

const canvas = ref<HTMLCanvasElement | null>(null);
const stats = ref<SceneStats | null>(null);
const failure = ref<string | null>(null);
const versions = window.flatchat?.versions;
let stop: (() => void) | undefined;

onMounted(async () => {
  if (!canvas.value) return;
  const smoke = new URLSearchParams(location.search).has('smoke');
  try {
    stop = await startScene(
      canvas.value,
      (s) => {
        stats.value = s;
      },
      smoke ? (report) => void window.flatchat?.smokeReport(report) : undefined,
    );
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
    if (smoke) void window.flatchat?.smokeReport({ backend: 'none', error: failure.value });
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

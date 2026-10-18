<!-- SPDX-License-Identifier: MPL-2.0 -->
<!-- The voice lounge's view: a top-down map of everyone nearby (you in white, your 25 m voice range,
     others lit while they speak) and the numbers the listening test needs. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Lounge, type LoungeState } from './lounge';

const props = defineProps<{ url: string; token: string }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const view = ref<LoungeState | null>(null);
const lounge = new Lounge();
let frame = 0;

const down = (e: KeyboardEvent): void => lounge.key(e.code, true);
const up = (e: KeyboardEvent): void => lounge.key(e.code, false);

function draw(): void {
  const c = canvas.value;
  const ctx = c?.getContext('2d');
  if (c && ctx) {
    const s = lounge.state;
    const w = (c.width = c.clientWidth);
    const h = (c.height = c.clientHeight);
    const scale = Math.min(w, h) / 70;
    const toX = (x: number): number => w / 2 + (x - s.me.x) * scale;
    const toY = (z: number): number => h / 2 + (z - s.me.z) * scale;
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1a2030';
    for (let g = Math.floor((s.me.x - 40) / 2) * 2; g < s.me.x + 40; g += 2) {
      ctx.beginPath();
      ctx.moveTo(toX(g), 0);
      ctx.lineTo(toX(g), h);
      ctx.stroke();
    }
    for (let g = Math.floor((s.me.z - 40) / 2) * 2; g < s.me.z + 40; g += 2) {
      ctx.beginPath();
      ctx.moveTo(0, toY(g));
      ctx.lineTo(w, toY(g));
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(249, 205, 38, 0.4)';
    ctx.beginPath();
    ctx.arc(toX(s.me.x), toY(s.me.z), 25 * scale, 0, Math.PI * 2);
    ctx.stroke();
    for (const b of s.others) {
      ctx.fillStyle = b.speaking > 1 ? '#f9cd26' : '#6b7a90';
      ctx.beginPath();
      ctx.arc(toX(b.x), toY(b.z), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d8dee9';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(`${b.name} · ${Math.hypot(b.x - s.me.x, b.z - s.me.z).toFixed(1)} m`, toX(b.x) + 10, toY(b.z) + 4);
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(toX(s.me.x), toY(s.me.z), 7, 0, Math.PI * 2);
    ctx.fill();
    view.value = { ...s, others: [...s.others], me: { ...s.me } };
  }
  frame = requestAnimationFrame(draw);
}

onMounted(() => {
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  void lounge.start(props.url, props.token);
  frame = requestAnimationFrame(draw);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  window.removeEventListener('keydown', down);
  window.removeEventListener('keyup', up);
  lounge.stop();
});
</script>

<template>
  <canvas
    ref="canvas"
    class="map"
  />
  <div
    v-if="view"
    class="hud"
  >
    <div><strong>FlatChat</strong> · voice lounge (S0.08) · {{ view.status }}<span v-if="view.entity >= 0"> · you are #{{ view.entity }}</span></div>
    <div
      v-if="view.error"
      class="failure"
    >
      {{ view.error }}
    </div>
    <div>WASD or arrows to walk · M: microphone {{ view.muted ? 'muted' : 'on' }} (level {{ view.micLevel }} of 15)</div>
    <div>Round trip {{ view.rttMs }} ms · {{ view.others.length }} other player(s)</div>
    <div
      v-for="b in view.others"
      :key="b.entity"
    >
      {{ b.name }}: {{ Math.hypot(b.x - view.me.x, b.z - view.me.z).toFixed(1) }} m{{ b.speaking > 1 ? ' · speaking' : '' }}
    </div>
    <div v-if="view.voice">
      Voice heard: {{ view.voice.jitter.played }} frames, {{ view.voice.jitter.recovered }} rebuilt, {{ view.voice.jitter.concealed }} concealed, delay {{ view.voice.jitter.delayMs.toFixed(0) }} ms
    </div>
    <div v-if="view.audio">
      Audio devices: output {{ view.audio.outputMs }} ms, input {{ view.audio.inputMs ?? 'unknown' }} ms
    </div>
  </div>
</template>

<style scoped>
.map {
  display: block;
  width: 100%;
  height: 100%;
}

.hud {
  position: fixed;
  top: 12px;
  left: 12px;
  padding: 8px 10px;
  background: rgb(0 0 0 / 0.55);
  color: #e8e8ea;
  font: 13px/1.5 system-ui, sans-serif;
  pointer-events: none;
}

.failure {
  color: #ff8a80;
}
</style>

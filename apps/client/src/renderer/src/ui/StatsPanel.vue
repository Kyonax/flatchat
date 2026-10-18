<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// The stats panel (S6.08; the owner's manual testing asked for it): over the world, twice a second,
// the frame rate and frame times, what this frame drew, memory, the resolution drawn, the preset and
// the tuner's step, the avatars at each level, effects, the round trip and the 3D audio's rays.
import { useI18n } from 'vue-i18n';
import type { WorldState } from '../world/session';

defineProps<{ state: WorldState }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="stats whud"
    data-test="stats"
    :data-draws="state.stats?.draws ?? 0"
    :data-preset="state.stats?.preset ?? ''"
  >
    <h3>{{ t('stats.title') }}</h3>
    <dl v-if="state.stats">
      <dt>{{ t('stats.fps') }}</dt>
      <dd>{{ state.fps }}</dd>
      <dt>{{ t('stats.frame') }}</dt>
      <dd>{{ t('stats.frameValue', { mean: state.stats.frameMs, p95: state.stats.p95Ms }) }}</dd>
      <dt>{{ t('stats.draws') }}</dt>
      <dd>{{ state.stats.draws }}</dd>
      <dt>{{ t('stats.triangles') }}</dt>
      <dd>{{ state.stats.triangles.toLocaleString() }}</dd>
      <dt>{{ t('stats.memory') }}</dt>
      <dd>{{ t('stats.memoryValue', { geometries: state.stats.geometries, textures: state.stats.textures, heap: state.stats.heapMb }) }}</dd>
      <dt>{{ t('stats.resolution') }}</dt>
      <dd>{{ state.stats.width }}×{{ state.stats.height }} · ×{{ state.stats.pixelRatio }}</dd>
      <dt>{{ t('stats.quality') }}</dt>
      <dd>{{ t(`settings.graphics.presets.${state.stats.preset}`) }} · {{ t('stats.step', { step: state.stats.step }) }}</dd>
      <dt>{{ t('stats.avatars') }}</dt>
      <dd>{{ state.avatars.lod0 }} / {{ state.avatars.lod1 }} / {{ state.avatars.lod2 }} / {{ state.avatars.impostor }}</dd>
      <dt>{{ t('stats.effects') }}</dt>
      <dd>{{ state.effects.instances }}</dd>
      <dt>{{ t('stats.network') }}</dt>
      <dd>{{ t('stats.networkValue', { rtt: state.rttMs, players: state.players }) }}</dd>
      <dt>{{ t('stats.audio') }}</dt>
      <dd>{{ t('stats.audioValue', { rays: state.audio.rays, ms: state.audio.rayMs }) }}</dd>
      <dt>{{ t('stats.backend') }}</dt>
      <dd>{{ state.backend }}</dd>
    </dl>
  </div>
</template>

<style scoped>
.stats {
  top: 56px;
  left: 12px;
  font-size: var(--fs-xs);
  min-width: 17rem;
}

h3 {
  margin: 0 0 4px;
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1px 12px;
  margin: 0;
}

dt {
  color: var(--muted);
}

dd {
  margin: 0;
  color: var(--bright);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>

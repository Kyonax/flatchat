<!-- SPDX-License-Identifier: MPL-2.0 -->
<!-- Screen overlays (S6.02): each at its screen point over the world, its longer side a share of
     the screen's height, with its slow motion (none under prefers-reduced-motion). What shows and
     how big was decided in world/overlays.ts; nothing here takes a click. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { ShownOverlay } from '../world/overlays';

const props = defineProps<{ overlays: readonly ShownOverlay[]; safeMode: boolean }>();

/** Where each screen point sits, as CSS: a margin from the edges, centred along the others. */
const PLACES: Record<string, Record<string, string>> = {
  'top-left': { top: '3vh', left: '3vh' },
  top: { top: '3vh', left: '50%', '--x': '-50%' },
  'top-right': { top: '3vh', right: '3vh' },
  left: { top: '50%', left: '3vh', '--y': '-50%' },
  centre: { top: '50%', left: '50%', '--x': '-50%', '--y': '-50%' },
  right: { top: '50%', right: '3vh', '--y': '-50%' },
  'bottom-left': { bottom: '3vh', left: '3vh' },
  bottom: { bottom: '3vh', left: '50%', '--x': '-50%' },
  'bottom-right': { bottom: '3vh', right: '3vh' },
};

function styleOf(o: ShownOverlay): Record<string, string> {
  // The longer side is size × the screen's height; a world's full-screen overlay fills it.
  const long = o.look.size * 100;
  const full = o.whose === 'world' && o.look.size >= 1;
  const box: Record<string, string> = full ? { inset: '0', width: '100vw', height: '100vh', 'object-fit': 'cover' } : o.aspect >= 1 ? { width: `${long}vh`, height: `${long / o.aspect}vh` } : { width: `${long * o.aspect}vh`, height: `${long}vh` };
  return { ...(full ? {} : PLACES[o.look.hud]), ...box, '--o': String(o.look.opacity) };
}

const counts = computed(() => ({
  mine: props.overlays.filter((o) => o.whose === 'mine').length,
  others: props.overlays.filter((o) => o.whose === 'other').length,
  world: props.overlays.filter((o) => o.whose === 'world').length,
}));
</script>

<template>
  <div
    class="screen-overlays"
    data-test="overlays"
    :data-mine="counts.mine"
    :data-others="counts.others"
    :data-world="counts.world"
    :data-safe="safeMode ? 1 : 0"
    aria-hidden="true"
  >
    <img
      v-for="o in overlays"
      :key="o.key"
      :src="o.src"
      alt=""
      draggable="false"
      data-test="overlay"
      :data-whose="o.whose"
      :data-hud="o.look.hud"
      :class="['overlay', `motion-${o.look.motion}`]"
      :style="styleOf(o)"
    >
  </div>
</template>

<style scoped>
.screen-overlays {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 2;
}

.overlay {
  position: absolute;
  opacity: var(--o);
  transform: translate(var(--x, 0), var(--y, 0));
  user-select: none;
}

/* Each cycle two seconds (OVERLAY_LIMITS.periodS): nothing comes near flashing. A pulse fades only
   to half its opacity. */
.motion-pulse {
  animation: overlay-pulse 2s ease-in-out infinite;
}

.motion-bob {
  animation: overlay-bob 2s ease-in-out infinite;
}

.motion-spin {
  animation: overlay-spin 2s linear infinite;
}

@keyframes overlay-pulse {
  50% {
    opacity: calc(var(--o) * 0.5);
  }
}

@keyframes overlay-bob {
  50% {
    transform: translate(var(--x, 0), calc(var(--y, 0%) - 1vh));
  }
}

@keyframes overlay-spin {
  to {
    transform: translate(var(--x, 0), var(--y, 0)) rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .overlay {
    animation: none;
  }
}
</style>

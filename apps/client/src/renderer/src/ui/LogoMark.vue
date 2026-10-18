<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// The mark (S6.07): a square speech bubble with a stepped tail and three square dots, drawn from the
// same squares as the program's icon (shared/logo.ts), in the accent and the brightest ink. With
// `wordmark`, the name beside it in capitals at the widest tracking.
import { useI18n } from 'vue-i18n';
import { LOGO_GRID, LOGO_RECTS } from '../../../shared/logo';

withDefaults(defineProps<{ size?: number; wordmark?: boolean }>(), { size: 28, wordmark: false });
const { t } = useI18n();
</script>

<template>
  <span
    class="logo"
    data-test="logo"
  >
    <svg
      :width="size"
      :height="size"
      :viewBox="`0 0 ${LOGO_GRID} ${LOGO_GRID}`"
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <rect
        v-for="(r, i) in LOGO_RECTS"
        :key="i"
        :x="r.x"
        :y="r.y"
        :width="r.w"
        :height="r.h"
        :fill="r.ink === 'accent' ? 'var(--accent)' : 'var(--bright)'"
      />
    </svg>
    <span
      v-if="wordmark"
      class="wordmark"
    >{{ t('app.name') }}</span>
  </span>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
</style>

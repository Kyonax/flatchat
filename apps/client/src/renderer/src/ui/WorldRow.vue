<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ world: FlatchatWorld; favourite: boolean; joining: string }>();
const emit = defineEmits<{ join: [world: FlatchatWorld]; toggle: [world: FlatchatWorld] }>();
const { t } = useI18n();

const full = computed(() => props.world.online && props.world.players >= props.world.capacity);
</script>

<template>
  <li
    class="row world"
    :data-world="world.id"
  >
    <span class="grow">
      <strong>{{ world.name }}</strong>
      <span class="muted"> · {{ world.online ? t('home.players', { n: world.players, max: world.capacity }) : t('home.offline') }}</span>
    </span>
    <button
      type="button"
      class="star"
      :aria-pressed="favourite"
      :aria-label="favourite ? t('home.unfavourite') : t('home.favourite')"
      :title="favourite ? t('home.unfavourite') : t('home.favourite')"
      data-test="favourite"
      @click="emit('toggle', world)"
    >
      {{ favourite ? t('home.starOn') : t('home.starOff') }}
    </button>
    <button
      type="button"
      class="primary"
      :disabled="joining !== '' || !world.online || full"
      data-test="join"
      @click="emit('join', world)"
    >
      {{ joining === world.id ? t('home.joining') : full ? t('home.full') : t('home.join') }}
    </button>
  </li>
</template>

<style scoped>
.world {
  padding: 8px 0;
  border-top: 1px solid var(--line);
}

.star {
  min-width: 2.4em;
  font-size: 1.1rem;
  line-height: 1;
}

.star[aria-pressed='true'] {
  color: var(--accent);
}
</style>

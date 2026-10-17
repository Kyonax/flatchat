<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// Offline mode (S2.13): the worlds on this computer (the ones built into FlatChat and any folder it
// was started with); a world plays in the client's own main process, the player a guest.
defineProps<{ joining: string; error: string }>();
const emit = defineEmits<{ play: [world: { id: string; name: string }]; back: [] }>();
const { t } = useI18n();
const worlds = ref<Array<{ id: string; name: string }> | undefined>(undefined);

onMounted(async () => {
  worlds.value = (await window.flatchat?.offlineWorlds()) ?? [];
});
</script>

<template>
  <div class="screen">
    <div class="card">
      <h1>{{ t('offline.title') }}</h1>
      <p class="muted">
        {{ t('offline.lead') }}
      </p>
      <p
        v-if="worlds === undefined"
        class="muted"
      >
        {{ t('offline.loading') }}
      </p>
      <p
        v-else-if="worlds.length === 0"
        class="muted"
      >
        {{ t('offline.none') }}
      </p>
      <ul
        v-else
        class="plain"
        data-test="offline-worlds"
      >
        <li
          v-for="w in worlds"
          :key="w.id"
          class="row world"
          :data-world="w.id"
        >
          <strong class="grow">{{ w.name }}</strong>
          <button
            type="button"
            class="primary"
            :disabled="joining !== ''"
            data-test="play"
            @click="emit('play', w)"
          >
            {{ joining === w.id ? t('offline.starting') : t('offline.play') }}
          </button>
        </li>
      </ul>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <p>
        <button
          type="button"
          data-test="offline-back"
          @click="emit('back')"
        >
          {{ t('offline.back') }}
        </button>
      </p>
    </div>
  </div>
</template>

<style scoped>
.world {
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
</style>

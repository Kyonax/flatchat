<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { keyLabel } from './keys';

const props = defineProps<{ talkKey: string }>();
const emit = defineEmits<{ choose: [mode: 'open' | 'push'] }>();
const { t } = useI18n();
// Open microphone is the highlighted default (S1.11, Q-L13).
const mode = ref<'open' | 'push'>('open');
</script>

<template>
  <div class="overlay">
    <div
      class="card"
      role="dialog"
      aria-labelledby="mic-title"
    >
      <h1 id="mic-title">
        {{ t('mic.title') }}
      </h1>
      <p class="muted">
        {{ t('mic.lead') }}
      </p>
      <label
        class="choice"
        :class="{ chosen: mode === 'open' }"
      >
        <input
          v-model="mode"
          type="radio"
          value="open"
          data-test="mic-open"
        >
        <span><strong>{{ t('mic.open') }}</strong><br><span class="muted">{{ t('mic.openHint') }}</span></span>
      </label>
      <label
        class="choice"
        :class="{ chosen: mode === 'push' }"
      >
        <input
          v-model="mode"
          type="radio"
          value="push"
          data-test="mic-push"
        >
        <span><strong>{{ t('mic.push') }}</strong><br><span class="muted">{{ t('mic.pushHint', { key: keyLabel(props.talkKey, t) }) }}</span></span>
      </label>
      <button
        type="button"
        class="primary"
        data-test="mic-choose"
        @click="emit('choose', mode)"
      >
        {{ t('mic.choose') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 0.55);
}

.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  margin: 8px 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
}

.choice.chosen {
  border-color: var(--accent);
}

.choice input {
  margin-top: 5px;
}
</style>

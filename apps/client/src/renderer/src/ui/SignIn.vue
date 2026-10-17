<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ state: FlatchatAuthState }>();
defineEmits<{ 'sign-in': []; cancel: [] }>();
const { t } = useI18n();

const waiting = computed(() => props.state.status === 'waiting');
const error = computed(() => {
  if (props.state.status !== 'signed-out' || !props.state.error) return '';
  const code = props.state.error;
  return code === 'unreachable' || code === 'expired' ? t(`signin.errors.${code}`) : t('signin.errors.failed');
});
</script>

<template>
  <div class="screen">
    <div class="card">
      <h1>{{ t('signin.title') }}</h1>
      <p class="muted">
        {{ t('signin.lead') }}
      </p>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <div
        v-if="waiting"
        class="row"
      >
        <span class="grow">{{ t('signin.waiting') }}</span>
        <button
          type="button"
          data-test="cancel"
          @click="$emit('cancel')"
        >
          {{ t('signin.cancel') }}
        </button>
      </div>
      <button
        v-else
        type="button"
        class="primary"
        data-test="sign-in"
        @click="$emit('sign-in')"
      >
        {{ t('signin.button') }}
      </button>
      <p class="muted">
        {{ t('signin.invited') }}
      </p>
    </div>
  </div>
</template>

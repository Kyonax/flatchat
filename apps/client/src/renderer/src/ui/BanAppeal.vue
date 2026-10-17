<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// An appeal against a world's ban (S3.07): where the player's appeal stands, or a form to send one
// to the world's owner through the core, with the reason the world gave.
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ worldId: string; reason: string }>();
const { t, te } = useI18n();
const bridge = window.flatchat;
const appeal = ref<{ status: 'pending' | 'upheld' | 'reversed'; note: string } | null | undefined>(undefined);
const text = ref('');
const sending = ref(false);
const error = ref('');

onMounted(async () => {
  const r = await bridge?.banAppeal(props.worldId);
  appeal.value = r?.ok ? r.appeal : null;
});

async function send(): Promise<void> {
  if (!bridge || !text.value.trim()) return;
  sending.value = true;
  error.value = '';
  const r = await bridge.appealBan(props.worldId, props.reason, text.value.trim());
  sending.value = false;
  if (!r.ok) {
    error.value = t('appeal.failed', { reason: te(`home.reasons.${r.error}`) ? t(`home.reasons.${r.error}`) : r.error });
    return;
  }
  appeal.value = { status: 'pending', note: '' };
}
</script>

<template>
  <div
    class="appeal"
    data-test="appeal"
  >
    <template v-if="appeal">
      <p data-test="appeal-status">
        {{ t(`appeal.${appeal.status}`) }}
      </p>
      <p v-if="appeal.note">
        {{ t('appeal.note', { note: appeal.note }) }}
      </p>
    </template>
    <form
      v-else-if="appeal === null"
      @submit.prevent="send"
    >
      <p class="muted small">
        {{ t('appeal.lead') }}
      </p>
      <textarea
        v-model="text"
        rows="3"
        maxlength="2000"
        :placeholder="t('appeal.placeholder')"
        data-test="appeal-text"
      />
      <p
        v-if="error"
        class="error small"
      >
        {{ error }}
      </p>
      <button
        type="submit"
        :disabled="sending || !text.trim()"
        data-test="appeal-send"
      >
        {{ t('appeal.send') }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.appeal textarea {
  width: 100%;
  margin: 6px 0;
}
</style>

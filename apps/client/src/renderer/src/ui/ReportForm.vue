<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// A report from inside a world (S3.02): which kind, what happened, and whether the last seconds of
// what this player heard go with it; then the receipt. The decision comes later, on the home screen.
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { REPORT_CATEGORIES, type ReportCategory, type ReportDraft } from '../world/report';

const props = defineProps<{
  target: ReportDraft['target'];
  file: (draft: ReportDraft) => Promise<{ ok: true; receipt: string } | { ok: false; error: string }>;
}>();
const emit = defineEmits<{ close: [] }>();
const { t, te } = useI18n();

const category = ref<ReportCategory>('harassment');
const text = ref('');
const withClip = ref(true);
const sending = ref(false);
const receipt = ref('');
const error = ref('');

async function send(): Promise<void> {
  if (!text.value.trim() || sending.value) return;
  sending.value = true;
  error.value = '';
  const r = await props.file({ category: category.value, target: props.target, text: text.value.trim(), withClip: withClip.value });
  sending.value = false;
  if (r.ok) receipt.value = r.receipt;
  else error.value = t('report.failed', { reason: te(`home.reasons.${r.error}`) ? t(`home.reasons.${r.error}`) : r.error });
}
</script>

<template>
  <div class="center">
    <div
      class="card report"
      role="dialog"
      data-test="report"
    >
      <h1>{{ target.kind === 'world' ? t('report.titleWorld', { name: target.name }) : t('report.titlePlayer', { name: target.name }) }}</h1>
      <template v-if="receipt">
        <p
          role="status"
          data-test="report-receipt"
          :data-receipt="receipt"
        >
          {{ t('report.sent', { receipt }) }}
        </p>
        <button
          type="button"
          class="primary"
          data-test="report-done"
          @click="emit('close')"
        >
          {{ t('report.done') }}
        </button>
      </template>
      <form
        v-else
        @submit.prevent="send"
      >
        <label for="report-category">{{ t('report.category') }}</label>
        <select
          id="report-category"
          v-model="category"
          data-test="report-category"
        >
          <option
            v-for="c in REPORT_CATEGORIES"
            :key="c"
            :value="c"
          >
            {{ t(`report.categories.${c}`) }}
          </option>
        </select>
        <label for="report-text">{{ t('report.text') }}</label>
        <textarea
          id="report-text"
          v-model="text"
          rows="4"
          maxlength="2000"
          data-test="report-text"
        />
        <label class="check">
          <input
            v-model="withClip"
            type="checkbox"
            data-test="report-clip"
          >
          {{ t('report.withClip') }}
        </label>
        <p
          v-if="error"
          class="error small"
        >
          {{ error }}
        </p>
        <div class="row">
          <button
            type="button"
            @click="emit('close')"
          >
            {{ t('report.cancel') }}
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="sending || !text.trim()"
            data-test="report-send"
          >
            {{ t('report.send') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.report {
  width: min(28rem, calc(100vw - 32px));
  display: grid;
  gap: 6px;
}

.report form {
  display: grid;
  gap: 6px;
}

.report textarea {
  width: 100%;
}

.check {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>

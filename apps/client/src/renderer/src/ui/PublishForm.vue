<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { COMMERCIAL_USAGES, CREDIT_NOTATIONS, type Licence, MODIFICATIONS, STRICT_LICENCE, USAGE_FLAGS } from '@flatchat/content';
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// Publishing one of the account's own avatars or items to the free gallery (S5.06): its name, its
// licence fields (every one stated; they start at the strictest, and everyone may wear it, the
// gallery's rule) and the publisher's word that it is theirs to share and keeps to the content
// rules. The core refuses an avatar's licence that allows more than its file does.
const props = defineProps<{ kind: 'avatar' | 'item'; id: string; name: string }>();
const emit = defineEmits<{ done: []; cancel: [] }>();
const { t, te } = useI18n();
const name = ref(props.name);
const licence = reactive<Licence>({ ...STRICT_LICENCE });
const affirm = ref(false);
const busy = ref(false);
const error = ref('');

async function publish(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    // A plain copy: Vue's reactive objects cannot cross to the main process.
    const r = await window.flatchat?.publish({ kind: props.kind, id: props.id, name: name.value.trim(), licence: JSON.parse(JSON.stringify(licence)) as Licence, affirm: affirm.value });
    if (r && !r.ok) error.value = te(`publish.errors.${r.error}`) ? t(`publish.errors.${r.error}`) : t('publish.errors.failed');
    else if (r) emit('done');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form
    class="publish card"
    data-test="publish-form"
    @submit.prevent="publish"
  >
    <h3>{{ t('publish.title') }}</h3>
    <label>
      {{ t('publish.name') }}
      <input
        v-model="name"
        type="text"
        maxlength="64"
        data-test="publish-name"
      >
    </label>
    <p class="muted small">
      {{ t('publish.everyone') }}
    </p>
    <label>
      {{ t('licence.credit') }}
      <select v-model="licence.creditNotation">
        <option
          v-for="c in CREDIT_NOTATIONS"
          :key="c"
          :value="c"
        >{{ t(`licence.creditNotation.${c}`) }}</option>
      </select>
    </label>
    <label>
      {{ t('licence.changes') }}
      <select v-model="licence.modification">
        <option
          v-for="m in MODIFICATIONS"
          :key="m"
          :value="m"
        >{{ t(`licence.modification.${m}`) }}</option>
      </select>
    </label>
    <label>
      {{ t('licence.commercial') }}
      <select v-model="licence.commercialUsage">
        <option
          v-for="c in COMMERCIAL_USAGES"
          :key="c"
          :value="c"
        >{{ t(`licence.commercialUsage.${c}`) }}</option>
      </select>
    </label>
    <label class="check">
      <input
        v-model="licence.allowRedistribution"
        type="checkbox"
      >
      {{ t('publish.copies') }}
    </label>
    <fieldset>
      <legend>{{ t('licence.usages') }}</legend>
      <label
        v-for="f in USAGE_FLAGS"
        :key="f"
        class="check"
      >
        <input
          v-model="licence[f]"
          type="checkbox"
        >
        {{ t(`licence.usage.${f}`) }}
      </label>
    </fieldset>
    <label>
      {{ t('licence.text') }}
      <input
        v-model="licence.licenseUrl"
        type="text"
        maxlength="300"
      >
    </label>
    <label>
      {{ t('publish.other') }}
      <input
        v-model="licence.otherLicenseUrl"
        type="text"
        maxlength="300"
      >
    </label>
    <label class="check">
      <input
        v-model="affirm"
        type="checkbox"
        data-test="publish-affirm"
      >
      {{ t('publish.affirm') }}
    </label>
    <p
      v-if="error"
      class="error"
      role="alert"
      data-test="publish-error"
    >
      {{ error }}
    </p>
    <div class="row">
      <button
        type="submit"
        class="primary"
        data-test="publish-send"
        :disabled="busy || !affirm || !name.trim()"
      >
        {{ t('publish.send') }}
      </button>
      <button
        type="button"
        @click="emit('cancel')"
      >
        {{ t('publish.cancel') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.publish {
  display: grid;
  gap: 6px;
  margin: 8px 0;
  max-width: 460px;
}
.publish label {
  display: grid;
  gap: 2px;
}
.publish .check {
  display: flex;
  gap: 6px;
  align-items: center;
}
fieldset {
  border: none;
  padding: 0;
  margin: 0;
}
h3 {
  margin: 0;
  font-size: 0.95rem;
}
</style>

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// The account's avatars (S4.01): upload a VRM or a GLB (the main process opens the file dialog,
// reads the file and sends it; the page never holds the file or the token), watch it convert, see
// its rank or why it was refused, wear it, take it off, delete it.
const { t, te } = useI18n();
const avatars = ref<FlatchatAvatar[]>([]);
const uploading = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  const r = await window.flatchat?.avatars();
  if (r?.ok) avatars.value = r.avatars;
  // While one converts, look again every few seconds.
  if (timer) clearTimeout(timer);
  if (avatars.value.some((a) => a.status === 'converting' || a.status === 'uploading')) timer = setTimeout(() => void load(), 3000);
}

function failure(code: string): string {
  return te(`avatars.errors.${code}`) ? t(`avatars.errors.${code}`) : t('avatars.errors.failed');
}

async function upload(): Promise<void> {
  error.value = '';
  uploading.value = true;
  try {
    const r = await window.flatchat?.uploadAvatar();
    if (r && !r.ok && r.error !== 'cancelled') error.value = failure(r.error);
  } finally {
    uploading.value = false;
  }
  await load();
}

async function wear(a: FlatchatAvatar | null): Promise<void> {
  const r = await window.flatchat?.wearAvatar(a?.id ?? null);
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

async function remove(a: FlatchatAvatar): Promise<void> {
  const r = await window.flatchat?.deleteAvatar(a.id);
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

onMounted(load);
onBeforeUnmount(() => timer && clearTimeout(timer));
</script>

<template>
  <section data-test="avatars">
    <div class="row">
      <h2 class="grow">
        {{ t('avatars.title') }}
      </h2>
      <button
        type="button"
        data-test="upload-avatar"
        :disabled="uploading"
        @click="upload"
      >
        {{ uploading ? t('avatars.uploading') : t('avatars.upload') }}
      </button>
    </div>
    <p
      v-if="error"
      class="error"
      role="alert"
      data-test="avatar-error"
    >
      {{ error }}
    </p>
    <p
      v-if="avatars.length === 0"
      class="muted"
    >
      {{ t('avatars.none') }}
    </p>
    <ul
      v-else
      class="plain"
    >
      <li
        v-for="a in avatars"
        :key="a.id"
        data-test="avatar"
        :data-status="a.status"
      >
        <strong>{{ a.name || t('avatars.untitled') }}</strong>
        ·
        <span v-if="a.status === 'ready' && a.rank">{{ te(`avatars.rank.${a.rank}`) ? t(`avatars.rank.${a.rank}`) : a.rank }}</span>
        <span v-else>{{ t(`avatars.status.${a.status}`) }}</span>
        <template v-if="a.status === 'ready'">
          <span
            v-if="a.wearing"
            class="muted"
          > · {{ t('avatars.wearing') }}</span>
          <button
            v-if="a.wearing"
            type="button"
            @click="wear(null)"
          >
            {{ t('avatars.takeOff') }}
          </button>
          <button
            v-else
            type="button"
            class="primary"
            data-test="wear-avatar"
            @click="wear(a)"
          >
            {{ t('avatars.wear') }}
          </button>
        </template>
        <button
          v-if="a.status !== 'converting' && a.status !== 'uploading'"
          type="button"
          @click="remove(a)"
        >
          {{ t('avatars.delete') }}
        </button>
        <ul
          v-if="a.problems.length > 0 && a.status !== 'ready'"
          class="muted small"
        >
          <li
            v-for="(p, i) in a.problems"
            :key="i"
          >
            {{ p }}
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
  margin: 16px 0 8px;
}
li button {
  margin-left: 6px;
}
</style>

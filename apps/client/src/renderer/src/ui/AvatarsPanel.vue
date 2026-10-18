<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { BODY_KITS, type BodyKit } from '@flatchat/content';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import PublishForm from './PublishForm.vue';

// The account's avatars (S4.01): upload a VRM or a GLB (the main process opens the file dialog,
// reads the file and sends it; the page never holds the file or the token), watch it convert, see
// its rank or why it was refused, wear it, take it off, delete it. And the three standard bodies
// (S5.05), which any account wears with no upload: the one clothes are made for.
const { t, te } = useI18n();
const avatars = ref<FlatchatAvatar[]>([]);
const uploading = ref(false);
const error = ref('');
/** A standard body taken and still converting: worn once it is ready. */
const preparing = ref<string | undefined>(undefined);
/** The avatar being published to the gallery (S5.06). */
const publishing = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  const r = await window.flatchat?.avatars();
  if (r?.ok) avatars.value = r.avatars;
  const waited = preparing.value ? avatars.value.find((a) => a.id === preparing.value) : undefined;
  if (waited && waited.status !== 'converting' && waited.status !== 'uploading') {
    preparing.value = undefined;
    if (waited.status === 'ready') {
      await wear(waited);
      return;
    }
  }
  // While one converts, look again every few seconds.
  if (timer) clearTimeout(timer);
  if (avatars.value.some((a) => a.status === 'converting' || a.status === 'uploading')) timer = setTimeout(() => void load(), 3000);
}

async function takeKit(kit: BodyKit): Promise<void> {
  error.value = '';
  const r = await window.flatchat?.takeKit(kit);
  if (!r) return;
  if (!r.ok) {
    error.value = failure(r.error);
    return;
  }
  if (r.status === 'ready') {
    const w = await window.flatchat?.wearAvatar(r.id);
    if (w && !w.ok) error.value = failure(w.error);
  } else preparing.value = r.id;
  await load();
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

async function withdraw(a: FlatchatAvatar): Promise<void> {
  const r = a.published ? await window.flatchat?.withdraw(a.published) : undefined;
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

async function published(): Promise<void> {
  publishing.value = '';
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
    <h3>{{ t('kits.title') }}</h3>
    <p class="muted small">
      {{ t('kits.hint') }}
    </p>
    <div class="row">
      <button
        v-for="k in BODY_KITS"
        :key="k"
        type="button"
        :data-test="`kit-${k}`"
        :disabled="preparing !== undefined"
        @click="takeKit(k)"
      >
        {{ t('kits.wear', { body: t(`kits.${k}`) }) }}
      </button>
    </div>
    <p
      v-if="preparing"
      class="muted small"
      role="status"
      data-test="kit-preparing"
    >
      {{ t('kits.preparing') }}
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
        :data-kit="a.kit ?? ''"
        :data-wearing="a.wearing"
      >
        <strong>{{ a.kit ? t('kits.named', { body: t(`kits.${a.kit}`) }) : a.name || t('avatars.untitled') }}</strong>
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
        <span
          v-if="a.fromGallery"
          class="muted small"
        > · {{ t('gallery.fromGallery') }}</span>
        <template v-else-if="a.status === 'ready' && !a.kit">
          <template v-if="a.published">
            <span class="muted small"> · {{ t('gallery.inGallery') }}</span>
            <button
              type="button"
              @click="withdraw(a)"
            >
              {{ t('gallery.withdraw') }}
            </button>
          </template>
          <button
            v-else
            type="button"
            data-test="publish-avatar"
            @click="publishing = publishing === a.id ? '' : a.id"
          >
            {{ t('publish.open') }}
          </button>
        </template>
        <button
          v-if="a.status !== 'converting' && a.status !== 'uploading'"
          type="button"
          @click="remove(a)"
        >
          {{ t('avatars.delete') }}
        </button>
        <PublishForm
          v-if="publishing === a.id"
          :id="a.id"
          kind="avatar"
          :name="a.name"
          @done="published"
          @cancel="publishing = ''"
        />
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
h3 {
  font-size: 0.95rem;
  margin: 10px 0 4px;
}
.row button {
  margin-right: 6px;
}
li button {
  margin-left: 6px;
}
</style>

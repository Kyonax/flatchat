<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// The account's emotes and dances (S5.07): upload a VRMA, GLB, BVH or FBX as an emote (played once)
// or a dance (played on a loop); the main process opens the file dialog, reads the file and sends
// it. Watch it convert, see its length and whether it loops, or why it was refused; delete it.
// Playing them is the world's emotes menu (EmoteMenu.vue, B).
const { t, te } = useI18n();
const list = ref<FlatchatAnimation[]>([]);
const uploading = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  const r = await window.flatchat?.animations();
  if (r?.ok) list.value = r.animations;
  if (timer) clearTimeout(timer);
  if (list.value.some((a) => a.status === 'converting' || a.status === 'uploading')) timer = setTimeout(() => void load(), 3000);
}

function failure(code: string): string {
  return te(`emotes.errors.${code}`) ? t(`emotes.errors.${code}`) : t('emotes.errors.failed');
}

async function upload(use: 'emote' | 'dance'): Promise<void> {
  error.value = '';
  uploading.value = true;
  try {
    const r = await window.flatchat?.uploadAnimation(use);
    if (r && !r.ok && r.error !== 'cancelled') error.value = failure(r.error);
  } finally {
    uploading.value = false;
  }
  await load();
}

async function remove(a: FlatchatAnimation): Promise<void> {
  const r = await window.flatchat?.deleteAnimation(a.id);
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

onMounted(load);
onBeforeUnmount(() => timer && clearTimeout(timer));
</script>

<template>
  <section data-test="animations">
    <div class="row">
      <h2 class="grow">
        {{ t('emotes.yours') }}
      </h2>
      <button
        type="button"
        data-test="upload-emote"
        :disabled="uploading"
        @click="upload('emote')"
      >
        {{ t('emotes.uploadEmote') }}
      </button>
      <button
        type="button"
        data-test="upload-dance"
        :disabled="uploading"
        @click="upload('dance')"
      >
        {{ t('emotes.uploadDance') }}
      </button>
    </div>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="list.length === 0"
      class="muted"
    >
      {{ t('emotes.noneYet') }}
    </p>
    <ul
      v-else
      class="plain"
    >
      <li
        v-for="a in list"
        :key="a.id"
        data-test="animation"
        :data-status="a.status"
      >
        <strong>{{ a.name || t('items.untitled') }}</strong>
        ·
        <template v-if="a.status === 'ready'">
          <span>{{ t(`emotes.use.${a.use}`) }}</span>
          <span class="muted"> · {{ t('emotes.seconds', { n: (a.duration ?? 0).toFixed(1) }) }}{{ a.loop ? ` · ${t('emotes.loops')}` : '' }}</span>
        </template>
        <span v-else>{{ t(`avatars.status.${a.status}`) }}</span>
        <button
          v-if="a.status !== 'converting' && a.status !== 'uploading'"
          type="button"
          @click="remove(a)"
        >
          {{ t('emotes.delete') }}
        </button>
        <ul
          v-if="(a.status !== 'ready' && a.problems.length > 0) || a.warnings.length > 0"
          class="muted small"
        >
          <li
            v-for="(p, k) in a.status === 'ready' ? a.warnings : a.problems"
            :key="k"
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
li button,
.row button {
  margin-left: 6px;
}
</style>

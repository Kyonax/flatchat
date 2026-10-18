<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import LicenceSummary from './LicenceSummary.vue';

// The free gallery (S5.06, Q-M29): avatars and items anyone may wear, newest first, by kind and
// words, each with its makers and licence. Taking one adds the account's own copy to its avatars or
// items, worn like its own. An avatar shows its thumbnail (fetched by hash through the main process).
const emit = defineEmits<{ taken: [] }>();
const { t, te } = useI18n();
const kind = ref<'avatar' | 'item'>('avatar');
const text = ref('');
const entries = ref<FlatchatGalleryEntry[]>([]);
const next = ref<string | null>(null);
const open = ref('');
const error = ref('');
const loading = ref(false);
const thumbs = ref<Record<string, string>>({});

async function load(more = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const r = await window.flatchat?.gallery({ kind: kind.value, ...(text.value.trim() ? { q: text.value.trim() } : {}), ...(more && next.value ? { before: next.value } : {}) });
    if (!r) return;
    if (!r.ok) {
      error.value = failure(r.error);
      return;
    }
    entries.value = more ? [...entries.value, ...r.entries] : r.entries;
    next.value = r.next;
    for (const e of r.entries) if (e.kind === 'avatar') void thumbnail(e.manifest);
  } finally {
    loading.value = false;
  }
}

async function thumbnail(manifest: string): Promise<void> {
  if (thumbs.value[manifest]) return;
  const r = await window.flatchat?.avatarFile(manifest, 'thumbnail');
  if (r?.ok) thumbs.value = { ...thumbs.value, [manifest]: URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' })) };
}

function failure(code: string): string {
  return te(`gallery.errors.${code}`) ? t(`gallery.errors.${code}`) : t('gallery.errors.failed');
}

async function take(e: FlatchatGalleryEntry): Promise<void> {
  const r = await window.flatchat?.take(e.id);
  if (r && !r.ok) error.value = failure(r.error);
  else {
    entries.value = entries.value.map((x) => (x.id === e.id ? { ...x, taken: true, takes: x.taken ? x.takes : x.takes + 1 } : x));
    emit('taken');
  }
}

function pick(k: 'avatar' | 'item'): void {
  kind.value = k;
  void load();
}

function details(e: FlatchatGalleryEntry): string {
  if (e.kind === 'avatar') return e.rank && te(`avatars.rank.${e.rank}`) ? t(`avatars.rank.${e.rank}`) : (e.rank ?? '');
  const slot = e.slot && te(`items.slot.${e.slot}`) ? t(`items.slot.${e.slot}`) : (e.slot ?? '');
  return `${slot} · ${e.fits.length > 0 ? t('items.fits', { bodies: e.fits.map((b) => t(`kits.${b}`)).join(', ') }) : t('items.anyAvatar')}`;
}

onMounted(() => void load());
onBeforeUnmount(() => {
  for (const url of Object.values(thumbs.value)) URL.revokeObjectURL(url);
});
defineExpose({ load });
</script>

<template>
  <section data-test="gallery">
    <div class="row">
      <h2 class="grow">
        {{ t('gallery.title') }}
      </h2>
      <button
        type="button"
        :class="{ primary: kind === 'avatar' }"
        data-test="gallery-avatars"
        @click="pick('avatar')"
      >
        {{ t('gallery.avatars') }}
      </button>
      <button
        type="button"
        :class="{ primary: kind === 'item' }"
        data-test="gallery-items"
        @click="pick('item')"
      >
        {{ t('gallery.items') }}
      </button>
    </div>
    <form
      class="row"
      @submit.prevent="load()"
    >
      <input
        v-model="text"
        type="text"
        class="grow"
        maxlength="64"
        :placeholder="t('gallery.search')"
        :aria-label="t('gallery.search')"
      >
      <button type="submit">
        {{ t('gallery.find') }}
      </button>
    </form>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="!loading && entries.length === 0"
      class="muted"
    >
      {{ t('gallery.none') }}
    </p>
    <ul class="plain">
      <li
        v-for="e in entries"
        :key="e.id"
        data-test="gallery-entry"
        :data-entry="e.id"
      >
        <img
          v-if="e.kind === 'avatar' && thumbs[e.manifest]"
          class="thumb"
          :src="thumbs[e.manifest]"
          alt=""
        >
        <strong>{{ e.name || t('items.untitled') }}</strong>
        <span class="muted small"> · {{ t('gallery.by', { authors: e.authors.join(', ') }) }} · {{ details(e) }} · {{ t('gallery.takes', { n: e.takes }) }}</span>
        <span
          v-if="e.mine"
          class="muted small"
        > · {{ t('gallery.yours') }}</span>
        <button
          v-else-if="e.taken"
          type="button"
          disabled
        >
          {{ t('gallery.taken') }}
        </button>
        <button
          v-else
          type="button"
          class="primary"
          data-test="gallery-take"
          @click="take(e)"
        >
          {{ t('gallery.take') }}
        </button>
        <button
          type="button"
          @click="open = open === e.id ? '' : e.id"
        >
          {{ open === e.id ? t('gallery.less') : t('gallery.licence') }}
        </button>
        <LicenceSummary
          v-if="open === e.id"
          :licence="e.licence"
          :authors="e.authors"
        />
      </li>
    </ul>
    <button
      v-if="next"
      type="button"
      :disabled="loading"
      @click="load(true)"
    >
      {{ t('gallery.more') }}
    </button>
  </section>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
  margin: 16px 0 8px;
}
li {
  margin: 6px 0;
}
li button,
.row button {
  margin-left: 6px;
}
.thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  vertical-align: middle;
  margin-right: 8px;
}
</style>

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import effectStarters from '../../../../../../kits/effects/starters.json';
import wardrobe from '../../../../../../kits/items/wardrobe.json';
import DeclareItemForm from './DeclareItemForm.vue';
import PublishForm from './PublishForm.vue';

// The account's items and outfits (S5.05): upload one made on the body kits, as a GLB, an FBX, an
// OBJ, a DAE or a .blend (S5.08; the main process opens the file dialog, reads the file and sends
// it; the page never holds the file or the token), saying what it is when its file cannot
// (DeclareItemForm.vue); watch it convert, see the bodies it fits or why it was refused, delete it;
// and the saved outfits, to delete. Wearing them is the world's quick menu (OutfitMenu.vue). The
// starter wardrobe (P.08, kits/items/) and the starter effects (S6.01, kits/effects/) are any
// account's for the taking, with no upload: each once, then one of the account's items like any
// other. An effect is uploaded the same way (an Effekseer file, package or zip), always declared.
const { t, te } = useI18n();
const items = ref<FlatchatItem[]>([]);
const outfits = ref<FlatchatOutfit[]>([]);
const uploading = ref(false);
const error = ref('');
/** The item being published to the gallery (S5.06). */
const publishing = ref('');
/** A file picked that cannot say what it is (S5.08): its declaration is asked for. */
const declaring = ref<{ token: string; name: string; format: string } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
/** The starter wardrobe, and the one being taken. */
const starters = [...wardrobe.items.map((i) => ({ id: i.id, slot: i.slot })), ...effectStarters.starters.map((s) => ({ id: s.id, slot: 'effect' }))];
const taking = ref('');
const taken = computed(() => new Set(items.value.filter((i) => i.starter && i.status !== 'refused' && i.status !== 'failed').map((i) => i.starter!)));

async function takeStarter(id: string): Promise<void> {
  error.value = '';
  taking.value = id;
  try {
    const r = await window.flatchat?.takeStarter(id);
    if (r && !r.ok) error.value = failure(r.error);
  } finally {
    taking.value = '';
  }
  await load();
}

async function load(): Promise<void> {
  const [a, b] = await Promise.all([window.flatchat?.items(), window.flatchat?.outfits()]);
  if (a?.ok) items.value = a.items;
  if (b?.ok) outfits.value = b.outfits;
  if (timer) clearTimeout(timer);
  if (items.value.some((i) => i.status === 'converting' || i.status === 'uploading')) timer = setTimeout(() => void load(), 3000);
}

function failure(code: string): string {
  return te(`items.errors.${code}`) ? t(`items.errors.${code}`) : t('items.errors.failed');
}

async function upload(): Promise<void> {
  error.value = '';
  uploading.value = true;
  try {
    const r = await window.flatchat?.uploadItem();
    if (r && !r.ok && 'token' in r) declaring.value = { token: r.token, name: r.name, format: r.format };
    else if (r && !r.ok && r.error !== 'cancelled') error.value = failure(r.error);
  } finally {
    uploading.value = false;
  }
  await load();
}

async function remove(i: FlatchatItem): Promise<void> {
  const r = await window.flatchat?.deleteItem(i.id);
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

async function withdraw(i: FlatchatItem): Promise<void> {
  const r = i.published ? await window.flatchat?.withdraw(i.published) : undefined;
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

async function declared(): Promise<void> {
  declaring.value = null;
  await load();
}

async function published(): Promise<void> {
  publishing.value = '';
  await load();
}

async function removeOutfit(o: FlatchatOutfit): Promise<void> {
  const r = await window.flatchat?.deleteOutfit(o.id);
  if (r && !r.ok) error.value = failure(r.error);
  await load();
}

function fitsText(i: FlatchatItem): string {
  return i.fits.length > 0 ? t('items.fits', { bodies: i.fits.map((b) => t(`kits.${b}`)).join(', ') }) : t('items.anyAvatar');
}

onMounted(load);
onBeforeUnmount(() => timer && clearTimeout(timer));
</script>

<template>
  <section data-test="items">
    <div class="row">
      <h2 class="grow">
        {{ t('items.title') }}
      </h2>
      <button
        type="button"
        data-test="upload-item"
        :disabled="uploading || declaring !== null"
        @click="upload"
      >
        {{ uploading ? t('items.uploading') : t('items.upload') }}
      </button>
    </div>
    <DeclareItemForm
      v-if="declaring"
      :token="declaring.token"
      :name="declaring.name"
      :format="declaring.format"
      @done="declared"
      @cancel="declaring = null"
    />
    <p
      v-if="error"
      class="error"
      role="alert"
      data-test="item-error"
    >
      {{ error }}
    </p>
    <h3>{{ t('items.starter.title') }}</h3>
    <p class="muted">
      {{ t('items.starter.hint') }}
    </p>
    <ul
      class="plain"
      data-test="starters"
    >
      <li
        v-for="s in starters"
        :key="s.id"
        data-test="starter"
        :data-id="s.id"
        :data-taken="taken.has(s.id)"
      >
        <strong>{{ te(`items.starter.names.${s.id}`) ? t(`items.starter.names.${s.id}`) : s.id }}</strong>
        <span class="muted"> · {{ te(`items.slot.${s.slot}`) ? t(`items.slot.${s.slot}`) : s.slot }}</span>
        <span
          v-if="taken.has(s.id)"
          class="muted"
        > · {{ t('items.starter.taken') }}</span>
        <button
          v-else
          type="button"
          data-test="take-starter"
          :disabled="taking !== ''"
          @click="takeStarter(s.id)"
        >
          {{ t('items.starter.take') }}
        </button>
      </li>
    </ul>
    <p
      v-if="items.length === 0"
      class="muted"
    >
      {{ t('items.none') }}
    </p>
    <ul
      v-else
      class="plain"
    >
      <li
        v-for="i in items"
        :key="i.id"
        data-test="item"
        :data-status="i.status"
      >
        <strong>{{ i.name || t('items.untitled') }}</strong>
        ·
        <template v-if="i.status === 'ready'">
          <span>{{ te(`items.slot.${i.slot}`) ? t(`items.slot.${i.slot}`) : i.slot }}</span>
          <span class="muted"> · {{ fitsText(i) }}</span>
        </template>
        <span v-else>{{ t(`avatars.status.${i.status}`) }}</span>
        <span
          v-if="i.fromGallery"
          class="muted small"
        > · {{ t('gallery.fromGallery') }}</span>
        <span
          v-else-if="i.starter"
          class="muted small"
        > · {{ t('items.starter.title') }}</span>
        <template v-else-if="i.status === 'ready'">
          <template v-if="i.published">
            <span
              class="muted small"
              data-test="item-published"
            > · {{ t('gallery.inGallery') }}</span>
            <button
              type="button"
              @click="withdraw(i)"
            >
              {{ t('gallery.withdraw') }}
            </button>
          </template>
          <button
            v-else
            type="button"
            data-test="publish-item"
            @click="publishing = publishing === i.id ? '' : i.id"
          >
            {{ t('publish.open') }}
          </button>
        </template>
        <button
          v-if="i.status !== 'converting' && i.status !== 'uploading'"
          type="button"
          @click="remove(i)"
        >
          {{ t('items.delete') }}
        </button>
        <PublishForm
          v-if="publishing === i.id"
          :id="i.id"
          kind="item"
          :name="i.name"
          @done="published"
          @cancel="publishing = ''"
        />
        <ul
          v-if="(i.status !== 'ready' && i.problems.length > 0) || i.warnings.length > 0"
          class="muted small"
        >
          <li
            v-for="(p, k) in i.status === 'ready' ? i.warnings : i.problems"
            :key="k"
          >
            {{ p }}
          </li>
        </ul>
      </li>
    </ul>
    <template v-if="outfits.length > 0">
      <h2>{{ t('outfits.saved') }}</h2>
      <ul class="plain">
        <li
          v-for="o in outfits"
          :key="o.id"
          data-test="saved-outfit"
        >
          <strong>{{ o.name }}</strong>
          <span class="muted small"> · {{ t('outfits.count', { n: o.items.length }) }}</span>
          <button
            type="button"
            @click="removeOutfit(o)"
          >
            {{ t('outfits.delete') }}
          </button>
        </li>
      </ul>
    </template>
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

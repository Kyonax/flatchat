<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { type AttachPoint, resolveOutfit, type Slot } from '@flatchat/content';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// The outfits quick menu in a world (S5.05): the account's saved outfits, one click each; its ready
// items, each on or off (an item put on takes the place of one it conflicts with: the same slot,
// the same attachment point, a full outfit's top and bottom); and saving what is worn as an outfit.
// The page asks the session to wear the result; the session sends it to the world.
const props = defineProps<{ outfit: FlatchatWorn[] }>();
const emit = defineEmits<{ wear: [items: FlatchatWorn[]]; close: [] }>();
const { t, te } = useI18n();
const items = ref<FlatchatItem[]>([]);
const outfits = ref<FlatchatOutfit[]>([]);
/** Each attachment's point, from its manifest. */
const points = ref<Record<string, AttachPoint>>({});
const name = ref('');
const error = ref('');
const saving = ref(false);

const ready = computed(() => items.value.filter((i) => i.status === 'ready' && i.manifest));
const wearing = computed(() => new Set(props.outfit.map((w) => w.item)));

async function load(): Promise<void> {
  const [a, b] = await Promise.all([window.flatchat?.items(), window.flatchat?.outfits()]);
  if (a?.ok) items.value = a.items;
  if (b?.ok) outfits.value = b.outfits;
  for (const i of ready.value) {
    if (i.slot !== 'attachment' || points.value[i.manifest!]) continue;
    const r = await window.flatchat?.itemFile(i.manifest!, 'manifest');
    if (r?.ok && r.manifest.attach) points.value = { ...points.value, [i.manifest!]: r.manifest.attach };
  }
}

function failure(code: string): string {
  return te(`outfits.errors.${code}`) ? t(`outfits.errors.${code}`) : t('outfits.errors.failed');
}

/** Puts an item on (taking the place of what it conflicts with) or takes it off. */
function toggle(i: FlatchatItem): void {
  const hash = i.manifest!;
  const rest = props.outfit.filter((w) => w.item !== hash);
  const next = wearing.value.has(hash) ? rest : [...rest, { item: hash }];
  const known = new Map(ready.value.map((x) => [x.manifest!, x]));
  // Items this account no longer lists stay as they are; the rest are settled by slot.
  const unknown = next.filter((w) => !known.has(w.item));
  const placed = next.filter((w) => known.has(w.item)).map((w) => ({ w, slot: known.get(w.item)!.slot ?? ('attachment' as Slot), attach: points.value[w.item] }));
  emit('wear', [...unknown, ...resolveOutfit(placed).map((p) => p.w)]);
}

async function save(): Promise<void> {
  error.value = '';
  if (!name.value.trim()) return;
  saving.value = true;
  try {
    // A plain copy: Vue's reactive arrays cannot cross to the main process.
    const r = await window.flatchat?.saveOutfit(null, name.value.trim(), JSON.parse(JSON.stringify(props.outfit)) as FlatchatWorn[]);
    if (r && !r.ok) error.value = failure(r.error);
    else name.value = '';
  } finally {
    saving.value = false;
  }
  await load();
}

function fitsText(i: FlatchatItem): string {
  return i.fits.length > 0 ? t('items.fits', { bodies: i.fits.map((b) => t(`kits.${b}`)).join(', ') }) : t('items.anyAvatar');
}

onMounted(load);
</script>

<template>
  <aside
    class="outfits card"
    data-test="outfit-menu"
  >
    <div class="row">
      <h2 class="grow">
        {{ t('outfits.title') }}
      </h2>
      <button
        type="button"
        @click="emit('close')"
      >
        {{ t('outfits.close') }}
      </button>
    </div>
    <h3>{{ t('outfits.saved') }}</h3>
    <p
      v-if="outfits.length === 0"
      class="muted small"
    >
      {{ t('outfits.noneSaved') }}
    </p>
    <ul
      v-else
      class="plain"
    >
      <li
        v-for="o in outfits"
        :key="o.id"
        data-test="outfit-saved"
      >
        <strong>{{ o.name }}</strong>
        <span class="muted small"> · {{ t('outfits.count', { n: o.items.length }) }}</span>
        <button
          type="button"
          data-test="outfit-wear"
          @click="emit('wear', o.items)"
        >
          {{ t('outfits.wear') }}
        </button>
      </li>
    </ul>
    <h3>{{ t('outfits.items') }}</h3>
    <p
      v-if="ready.length === 0"
      class="muted small"
    >
      {{ t('outfits.noItems') }}
    </p>
    <ul
      v-else
      class="plain"
    >
      <li
        v-for="i in ready"
        :key="i.id"
      >
        <label>
          <input
            type="checkbox"
            data-test="outfit-item"
            :data-item="i.manifest"
            :checked="wearing.has(i.manifest!)"
            @change="toggle(i)"
          >
          {{ i.name || t('items.untitled') }}
          <span class="muted small"> · {{ te(`items.slot.${i.slot}`) ? t(`items.slot.${i.slot}`) : i.slot }} · {{ fitsText(i) }}</span>
        </label>
      </li>
    </ul>
    <div class="row">
      <button
        type="button"
        data-test="outfit-off"
        :disabled="outfit.length === 0"
        @click="emit('wear', [])"
      >
        {{ t('outfits.takeAllOff') }}
      </button>
    </div>
    <form
      class="row"
      @submit.prevent="save"
    >
      <input
        v-model="name"
        class="grow"
        maxlength="64"
        data-test="outfit-name"
        :placeholder="t('outfits.name')"
        :aria-label="t('outfits.name')"
      >
      <button
        type="submit"
        data-test="outfit-save"
        :disabled="saving || !name.trim() || outfit.length === 0"
      >
        {{ t('outfits.save') }}
      </button>
    </form>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
  </aside>
</template>

<style scoped>
.outfits {
  position: absolute;
  top: 56px;
  left: 16px;
  width: min(360px, calc(100% - 32px));
  max-height: calc(100% - 120px);
  overflow: auto;
}
h2 {
  font-size: 1.05rem;
  margin: 0;
}
h3 {
  font-size: 0.95rem;
  margin: 12px 0 6px;
}
li button {
  margin-left: 6px;
}
</style>

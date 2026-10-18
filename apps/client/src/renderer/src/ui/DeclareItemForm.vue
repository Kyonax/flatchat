<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { ATTACH_POINTS, type AttachPoint, HUD_POINTS, type HudPoint, ItemFormatError, MODEL_SLOTS, OVERLAY_AUDIENCES, OVERLAY_LIMITS, OVERLAY_MOTIONS, type OverlayAudience, type OverlayMotion, readItemDeclaration, REGIONS, type Region, type Slot } from '@flatchat/content';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// What an item's file cannot say itself (S5.08): an FBX, an OBJ or a DAE keeps no declaration, so
// before it is sent the account gives its name, its slot, and the body it covers (hidden under it)
// or, for an attachment, the point it is worn at; and who made it. An effect (S6.01: an Effekseer
// file, package or zip) keeps none either: its slot is the effect's, and it asks the point it is
// worn at and the scale it plays at. An overlay (S6.02: a PNG) asks its screen point, its size,
// opacity and motion, and who sees it. Checked here as the core and the converter check it
// (packages/content's readItemDeclaration), then sent with the file the main process holds for it.
const props = defineProps<{ token: string; name: string; format: string }>();
const emit = defineEmits<{ done: []; cancel: [] }>();
const { t, te } = useI18n();
const name = ref(props.name);
const effect = props.format === 'effect';
const overlay = props.format === 'image';
const slot = ref<Slot>(effect ? 'effect' : overlay ? 'overlay' : 'top');
const hud = ref<HudPoint>('top-right');
const size = ref(0.15);
const opacity = ref(1);
const motion = ref<OverlayMotion>('none');
const audience = ref<OverlayAudience>('self');
const attach = ref<AttachPoint>(effect ? 'hips' : 'head_top');
const scale = ref(1);
const hides = ref<Region[]>([]);
const authors = ref('');
const busy = ref(false);
const problems = ref<string[]>([]);
const error = ref('');
const slots = MODEL_SLOTS;
const points = Object.keys(ATTACH_POINTS) as AttachPoint[];
const regions = Object.keys(REGIONS) as Region[];
const formatName = computed(() => (props.format === 'blend' ? '.blend' : props.format === 'gltf' ? 'GLB' : effect ? 'Effekseer' : overlay ? 'PNG' : props.format.toUpperCase()));

async function send(): Promise<void> {
  error.value = '';
  problems.value = [];
  let declaration;
  try {
    declaration = readItemDeclaration({
      name: name.value,
      slot: slot.value,
      authors: authors.value.split(',').map((a) => a.trim()).filter(Boolean),
      ...(slot.value === 'attachment'
        ? { attach: attach.value, hides: [] }
        : slot.value === 'effect'
          ? { attach: attach.value, hides: [], scale: Number(scale.value) }
          : slot.value === 'overlay'
            ? { hides: [], hud: hud.value, size: Number(size.value), opacity: Number(opacity.value), motion: motion.value, audience: audience.value }
            : { hides: [...hides.value] }),
    });
  } catch (err) {
    problems.value = err instanceof ItemFormatError ? err.problems : [String(err)];
    return;
  }
  busy.value = true;
  try {
    // A plain copy: Vue's reactive arrays cannot cross to the main process.
    const r = await window.flatchat?.uploadItem({ token: props.token, declaration: JSON.parse(JSON.stringify(declaration)) as FlatchatItemDeclaration });
    if (r && !r.ok) error.value = te(`items.errors.${r.error}`) ? t(`items.errors.${r.error}`) : t('items.errors.failed');
    else if (r) emit('done');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form
    class="declare card"
    data-test="declare-form"
    @submit.prevent="send"
  >
    <h3>{{ t('declare.title') }}</h3>
    <p class="muted small">
      {{ t('declare.why', { format: formatName }) }}
    </p>
    <label>
      {{ t('declare.name') }}
      <input
        v-model="name"
        type="text"
        maxlength="80"
        data-test="declare-name"
      >
    </label>
    <label v-if="!effect && !overlay">
      {{ t('declare.slot') }}
      <select
        v-model="slot"
        data-test="declare-slot"
      >
        <option
          v-for="s in slots"
          :key="s"
          :value="s"
        >{{ te(`items.slot.${s}`) ? t(`items.slot.${s}`) : s }}</option>
      </select>
    </label>
    <label v-if="slot === 'attachment' || slot === 'effect'">
      {{ t('declare.point') }}
      <select
        v-model="attach"
        data-test="declare-point"
      >
        <option
          v-for="p in points"
          :key="p"
          :value="p"
        >{{ t(`declare.points.${p}`) }}</option>
      </select>
    </label>
    <label v-if="slot === 'effect'">
      {{ t('declare.scale') }}
      <input
        v-model.number="scale"
        type="number"
        min="0.01"
        max="100"
        step="0.01"
        data-test="declare-scale"
      >
    </label>
    <template v-if="slot === 'overlay'">
      <label>
        {{ t('declare.hud') }}
        <select
          v-model="hud"
          data-test="declare-hud"
        >
          <option
            v-for="h in HUD_POINTS"
            :key="h"
            :value="h"
          >{{ t(`declare.huds.${h}`) }}</option>
        </select>
      </label>
      <label>
        {{ t('declare.size') }}
        <input
          v-model.number="size"
          type="number"
          :min="OVERLAY_LIMITS.size.min"
          :max="OVERLAY_LIMITS.size.max"
          step="0.01"
          data-test="declare-size"
        >
      </label>
      <label>
        {{ t('declare.opacity') }}
        <input
          v-model.number="opacity"
          type="number"
          :min="OVERLAY_LIMITS.opacity.min"
          max="1"
          step="0.05"
          data-test="declare-opacity"
        >
      </label>
      <label>
        {{ t('declare.motion') }}
        <select
          v-model="motion"
          data-test="declare-motion"
        >
          <option
            v-for="m in OVERLAY_MOTIONS"
            :key="m"
            :value="m"
          >{{ t(`declare.motions.${m}`) }}</option>
        </select>
      </label>
      <label>
        {{ t('declare.audience') }}
        <select
          v-model="audience"
          data-test="declare-audience"
        >
          <option
            v-for="a in OVERLAY_AUDIENCES"
            :key="a"
            :value="a"
          >{{ t(`declare.audiences.${a}`) }}</option>
        </select>
      </label>
    </template>
    <fieldset v-if="slot !== 'attachment' && slot !== 'effect' && slot !== 'overlay'">
      <legend>{{ t('declare.hides') }}</legend>
      <label
        v-for="r in regions"
        :key="r"
        class="check"
      >
        <input
          v-model="hides"
          type="checkbox"
          :value="r"
        >
        {{ t(`declare.regions.${r}`) }}
      </label>
    </fieldset>
    <label>
      {{ t('declare.authors') }}
      <input
        v-model="authors"
        type="text"
        maxlength="200"
      >
    </label>
    <ul
      v-if="problems.length > 0"
      class="error small"
      role="alert"
    >
      <li
        v-for="(p, k) in problems"
        :key="k"
      >
        {{ p }}
      </li>
    </ul>
    <p
      v-if="error"
      class="error"
      role="alert"
      data-test="declare-error"
    >
      {{ error }}
    </p>
    <div class="row">
      <button
        type="submit"
        class="primary"
        data-test="declare-send"
        :disabled="busy || !name.trim()"
      >
        {{ t('declare.send') }}
      </button>
      <button
        type="button"
        @click="emit('cancel')"
      >
        {{ t('declare.cancel') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.declare {
  display: grid;
  gap: 6px;
  margin: 8px 0;
  max-width: 460px;
}
.declare label {
  display: grid;
  gap: 2px;
}
.declare .check {
  display: flex;
  gap: 6px;
  align-items: center;
}
fieldset {
  border: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 12px;
}
legend {
  grid-column: 1 / -1;
}
h3 {
  margin: 0;
  font-size: 0.95rem;
}
</style>

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { BUILT_IN_EMOTES } from '../world/clips';

// The emotes menu in a world (S5.07): the gestures every player has (P.05's greeting and dance),
// then the account's own ready emotes and dances, one click each; the session sends the choice to
// the world, which plays it for everyone nearby in step. Walking ends it.
const props = defineProps<{ playing: string }>();
const emit = defineEmits<{ play: [anim: string | undefined]; close: [] }>();
const { t } = useI18n();
const list = ref<FlatchatAnimation[]>([]);
const ready = computed(() => list.value.filter((a) => a.status === 'ready' && a.manifest));

onMounted(async () => {
  const r = await window.flatchat?.animations();
  if (r?.ok) list.value = r.animations;
});
</script>

<template>
  <aside
    class="emotes card"
    data-test="emote-menu"
  >
    <div class="row">
      <h2 class="grow">
        {{ t('emotes.title') }}
      </h2>
      <button
        type="button"
        @click="emit('close')"
      >
        {{ t('emotes.close') }}
      </button>
    </div>
    <ul class="plain">
      <li
        v-for="b in BUILT_IN_EMOTES"
        :key="b.anim"
      >
        <button
          type="button"
          :class="{ primary: props.playing === b.anim }"
          data-test="emote-builtin"
          :data-anim="b.anim"
          @click="emit('play', b.anim)"
        >
          {{ t(`emotes.builtIn.${b.name}`) }}
        </button>
        <span class="muted small"> · {{ t(`emotes.use.${b.use}`) }} · {{ t('emotes.seconds', { n: b.duration.toFixed(1) }) }}</span>
      </li>
    </ul>
    <p
      v-if="ready.length === 0"
      class="muted small"
    >
      {{ t('emotes.none') }}
    </p>
    <ul
      v-else
      class="plain"
    >
      <li
        v-for="a in ready"
        :key="a.id"
      >
        <button
          type="button"
          :class="{ primary: props.playing === a.manifest }"
          data-test="emote-play"
          :data-anim="a.manifest"
          @click="emit('play', a.manifest!)"
        >
          {{ a.name || t('items.untitled') }}
        </button>
        <span class="muted small"> · {{ t(`emotes.use.${a.use}`) }} · {{ t('emotes.seconds', { n: (a.duration ?? 0).toFixed(1) }) }}</span>
      </li>
    </ul>
    <button
      type="button"
      data-test="emote-stop"
      :disabled="!props.playing"
      @click="emit('play', undefined)"
    >
      {{ t('emotes.stop') }}
    </button>
  </aside>
</template>

<style scoped>
.emotes {
  position: absolute;
  top: 56px;
  right: 16px;
  width: min(320px, calc(100% - 32px));
  max-height: calc(100% - 120px);
  overflow: auto;
}
h2 {
  font-size: 1.05rem;
  margin: 0;
}
li {
  margin: 4px 0;
}
</style>

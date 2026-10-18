<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// The help page (S6.07, Q-H4): everything in short, in the player's language, and the keys as this
// player has them; the credits are one button away.
import { POLICY_PAGE_IDS, type PolicyPage } from '@flatchat/content';
import { useI18n } from 'vue-i18n';
import type { Settings } from '../../../shared/settings';
import KeysHelp from './KeysHelp.vue';
import LogoMark from './LogoMark.vue';

defineProps<{ settings: Settings }>();
defineEmits<{ back: []; credits: [] }>();
const { t, locale } = useI18n();
function open(id: PolicyPage): void {
  void window.flatchat?.openPolicy(id, String(locale.value));
}
const SECTIONS = ['start', 'move', 'talk', 'people', 'you', 'settings', 'trouble'] as const;
</script>

<template>
  <div
    class="screen page"
    data-test="help"
  >
    <article class="sheet">
      <header class="row">
        <LogoMark
          :size="24"
          wordmark
        />
        <span class="grow" />
        <button
          data-test="help-credits"
          @click="$emit('credits')"
        >
          {{ t('credits.open') }}
        </button>
        <button
          data-test="help-back"
          @click="$emit('back')"
        >
          {{ t('settings.back') }}
        </button>
      </header>
      <h1>{{ t('help.title') }}</h1>
      <p class="lead">
        {{ t('help.intro') }}
      </p>
      <section
        v-for="s in SECTIONS"
        :key="s"
      >
        <h2>{{ t(`help.sections.${s}.title`) }}</h2>
        <p>{{ t(`help.sections.${s}.body`) }}</p>
      </section>
      <KeysHelp :keys="settings.keys" />
      <section data-test="policies">
        <h2>{{ t('help.policies.title') }}</h2>
        <p>{{ t('help.policies.lead') }}</p>
        <div class="policies">
          <button
            v-for="id in POLICY_PAGE_IDS"
            :key="id"
            type="button"
            :data-test="`policy-${id}`"
            @click="open(id)"
          >
            {{ t(`help.policies.items.${id}`) }}
          </button>
        </div>
      </section>
    </article>
  </div>
</template>

<style scoped>
.page {
  place-items: start center;
  padding: 32px 16px;
}

.sheet {
  width: min(56rem, calc(100vw - 32px));
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}

h1 {
  margin: 12px 0 0;
  font-size: var(--fs-title);
  color: var(--bright);
}

.lead {
  color: var(--bright);
  margin: 0;
}

section p {
  margin: 4px 0 0;
  max-width: 48rem;
}

.policies {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>

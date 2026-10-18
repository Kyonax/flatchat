<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// The keys (S6.07; the owner's manual testing asked for it): every action with the keys bound to it,
// as this player's keyboard prints them, in groups, and the keys that are always the same. In a world
// the help key (F1 unless rebound) opens and closes it over the view; the help page shows it too.
import { useI18n } from 'vue-i18n';
import type { Bindings } from '../../../shared/settings';
import { KEY_GROUPS } from './key-groups';
import { keyLabel } from './keys';

defineProps<{ keys: Bindings; closable?: boolean }>();
defineEmits<{ close: [] }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="keys-help"
    data-test="keys-help"
    role="dialog"
    :aria-label="t('help.keys.title')"
  >
    <header class="row">
      <h2 class="grow">
        {{ t('help.keys.title') }}
      </h2>
      <button
        v-if="closable"
        data-test="keys-help-close"
        :aria-label="t('help.keys.close')"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>
    <div class="groups">
      <section
        v-for="g in KEY_GROUPS"
        :key="g.id"
      >
        <h3>{{ t(`help.keys.groups.${g.id}`) }}</h3>
        <dl>
          <template
            v-for="a in g.actions"
            :key="a"
          >
            <dt>{{ t(`actions.${a}`) }}</dt>
            <dd>
              <kbd
                v-for="k in keys[a]"
                :key="k"
              >{{ keyLabel(k, t) }}</kbd>
            </dd>
          </template>
          <template v-if="g.id === 'always'">
            <dt>{{ t('help.keys.safeMode') }}</dt>
            <dd><kbd>{{ t('help.keys.shift') }}</kbd><kbd>{{ t('keys.Escape') }}</kbd></dd>
          </template>
        </dl>
      </section>
    </div>
    <p class="muted small">
      {{ t('help.keys.rebind') }}
    </p>
  </div>
</template>

<style scoped>
.keys-help {
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  padding: 16px 20px;
  width: min(60rem, 100%);
  max-height: calc(100vh - 64px);
  overflow: auto;
}

.groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 8px 28px;
}

dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  margin: 0;
}

dt {
  color: var(--text);
}

dd {
  margin: 0;
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}

kbd {
  font: inherit;
  font-size: var(--fs-xs);
  color: var(--bright);
  border: 1px solid var(--line-strong);
  padding: 0 6px;
  min-width: 1.6em;
  text-align: center;
}

.small {
  font-size: var(--fs-xs);
}
</style>

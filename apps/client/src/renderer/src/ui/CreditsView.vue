<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
// The credits page (S6.07, Q-J3): who made FlatChat, every model, sound, effect, font and data set in
// it with its creator and licence, and the software inside the client, all read from the
// repository's CREDITS.md when the client is built (one list for the file, the notices and the page).
// Sources are text to copy, not links: the client opens no address a page hands it (trap T16).
import { useI18n } from 'vue-i18n';
import creditsMarkdown from '../../../../../../CREDITS.md?raw';
import { readCredits } from './credits';
import LogoMark from './LogoMark.vue';

defineEmits<{ back: [] }>();
const { t } = useI18n();
const { assets, packages } = readCredits(creditsMarkdown);
const bare = (url: string): string => url.replace(/^https:\/\//, '');
</script>

<template>
  <div
    class="screen page"
    data-test="credits"
  >
    <article class="sheet">
      <header class="row">
        <LogoMark
          :size="24"
          wordmark
        />
        <span class="grow" />
        <button
          data-test="credits-back"
          @click="$emit('back')"
        >
          {{ t('settings.back') }}
        </button>
      </header>
      <h1>{{ t('credits.title') }}</h1>
      <p class="lead">
        {{ t('credits.made') }}
      </p>
      <section
        v-for="list in [{ id: 'assets', rows: assets }, { id: 'packages', rows: packages }]"
        :key="list.id"
      >
        <h2>{{ t(`credits.${list.id}`) }}</h2>
        <table :data-test="`credits-${list.id}`">
          <thead>
            <tr>
              <th>{{ t('credits.item') }}</th>
              <th>{{ t('credits.creator') }}</th>
              <th>{{ t('credits.licence') }}</th>
              <th>{{ t('credits.source') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in list.rows"
              :key="r.item"
            >
              <td>
                {{ r.item }}<span
                  v-if="r.version"
                  class="muted"
                > {{ r.version }}</span>
              </td>
              <td>{{ r.creator }}</td>
              <td class="licence">
                {{ r.licence }}
              </td>
              <td>
                <span
                  v-for="s in r.sources"
                  :key="s.url"
                  class="source"
                >{{ bare(s.url) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <p class="muted">
        {{ t('credits.notices') }}
      </p>
    </article>
  </div>
</template>

<style scoped>
.page {
  place-items: start center;
  padding: 32px 16px;
}

.sheet {
  width: min(72rem, calc(100vw - 32px));
  min-width: 0;
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

table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}

th:nth-child(1) {
  width: 34%;
}

th:nth-child(2) {
  width: 26%;
}

th:nth-child(3) {
  width: 14%;
}

th {
  text-align: left;
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--ls-label);
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding: 6px 8px;
}

td {
  vertical-align: top;
  border-bottom: 1px solid var(--line-faint);
  padding: 6px 8px;
  overflow-wrap: anywhere;
}

td .source {
  display: block;
  color: var(--cyan);
  user-select: text;
  overflow-wrap: anywhere;
}

.licence {
  color: var(--bright);
}
</style>

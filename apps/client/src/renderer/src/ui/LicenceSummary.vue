<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { type Licence, USAGE_FLAGS } from '@flatchat/content';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

// A gallery entry's licence fields (S5.06), in words: who made it, who may wear it, credit, copies,
// changes, commercial use, the four usages it allows, and the licence's own link (as text: the page
// opens no links).
const props = defineProps<{ licence: Licence; authors: string[] }>();
const { t } = useI18n();
const usages = computed(() => USAGE_FLAGS.filter((f) => props.licence[f]).map((f) => t(`licence.usage.${f}`)));
</script>

<template>
  <dl
    class="licence small"
    data-test="licence"
  >
    <dt>{{ t('licence.authors') }}</dt>
    <dd data-test="licence-authors">
      {{ authors.join(', ') }}
    </dd>
    <dt>{{ t('licence.wear') }}</dt>
    <dd>{{ t(`licence.avatarPermission.${licence.avatarPermission}`) }}</dd>
    <dt>{{ t('licence.credit') }}</dt>
    <dd>{{ t(`licence.creditNotation.${licence.creditNotation}`) }}</dd>
    <dt>{{ t('licence.copies') }}</dt>
    <dd>{{ licence.allowRedistribution ? t('licence.yes') : t('licence.no') }}</dd>
    <dt>{{ t('licence.changes') }}</dt>
    <dd>{{ t(`licence.modification.${licence.modification}`) }}</dd>
    <dt>{{ t('licence.commercial') }}</dt>
    <dd>{{ t(`licence.commercialUsage.${licence.commercialUsage}`) }}</dd>
    <dt>{{ t('licence.usages') }}</dt>
    <dd>{{ usages.length > 0 ? usages.join(', ') : t('licence.noUsages') }}</dd>
    <dt>{{ t('licence.text') }}</dt>
    <dd class="link">
      {{ licence.licenseUrl }}<template v-if="licence.otherLicenseUrl">
        · {{ licence.otherLicenseUrl }}
      </template>
    </dd>
  </dl>
</template>

<style scoped>
.licence {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 10px;
  margin: 6px 0;
}
dt {
  opacity: 0.75;
}
dd {
  margin: 0;
}
.link {
  word-break: break-all;
  user-select: text;
}
</style>

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ account: FlatchatAccount; remembered: boolean; joining: string; joinError: string }>();
const emit = defineEmits<{ join: [world: FlatchatWorld]; settings: []; 'sign-out': [] }>();
const { t } = useI18n();

const worlds = ref<FlatchatWorld[] | undefined>(undefined);
const listError = ref('');

async function load(): Promise<void> {
  worlds.value = undefined;
  listError.value = '';
  const r = await window.flatchat?.worlds();
  if (!r || !r.ok) {
    listError.value = r?.error === 'unreachable' ? t('signin.errors.unreachable') : t('signin.errors.failed');
    worlds.value = [];
    return;
  }
  worlds.value = r.worlds;
}

onMounted(load);
void props;
</script>

<template>
  <div class="screen">
    <div class="card">
      <div class="row">
        <h1 class="grow">
          {{ t('home.hello', { name: account.displayName }) }}
        </h1>
        <button
          type="button"
          data-test="settings"
          @click="emit('settings')"
        >
          {{ t('home.settings') }}
        </button>
      </div>
      <p class="muted">
        {{ remembered ? t('home.remembered') : t('home.notRemembered') }}
      </p>
      <div class="row">
        <h2 class="grow">
          {{ t('home.worlds') }}
        </h2>
        <button
          type="button"
          @click="load"
        >
          {{ t('home.refresh') }}
        </button>
      </div>
      <p
        v-if="listError"
        class="error"
      >
        {{ listError }}
      </p>
      <p
        v-else-if="worlds === undefined"
        class="muted"
      >
        {{ t('home.loadingWorlds') }}
      </p>
      <p
        v-else-if="worlds.length === 0"
        class="muted"
      >
        {{ t('home.noWorlds') }}
      </p>
      <ul
        v-else
        class="plain worlds"
      >
        <li
          v-for="w in worlds"
          :key="w.id"
          class="row world"
        >
          <span class="grow"><strong>{{ w.name }}</strong> <span class="muted">· {{ t('home.capacity', { n: w.capacity }) }}</span></span>
          <button
            type="button"
            class="primary"
            :disabled="joining !== ''"
            data-test="join"
            @click="emit('join', w)"
          >
            {{ joining === w.id ? t('home.joining') : t('home.join') }}
          </button>
        </li>
      </ul>
      <p
        v-if="joinError"
        class="error"
        role="alert"
      >
        {{ joinError }}
      </p>
      <p>
        <button
          type="button"
          data-test="sign-out"
          @click="emit('sign-out')"
        >
          {{ t('home.signOut') }}
        </button>
      </p>
    </div>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
  margin: 16px 0 8px;
}

.world {
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
</style>

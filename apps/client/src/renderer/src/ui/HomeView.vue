<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import WorldRow from './WorldRow.vue';

// The world browser (S2.09, Q-L4, Q-L11): join by a world's ID, the account's favourites, and the
// public list (open worlds below their recommended count, busiest first).
defineProps<{ account: FlatchatAccount; remembered: boolean; joining: string; joinError: string }>();
const emit = defineEmits<{ join: [world: FlatchatWorld]; settings: []; 'sign-out': [] }>();
const { t, te } = useI18n();

const WORLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const worlds = ref<FlatchatWorld[] | undefined>(undefined);
const favourites = ref<FlatchatWorld[]>([]);
const listError = ref('');
const byId = ref('');
const byIdError = ref('');
const looking = ref(false);
const starred = computed(() => new Set(favourites.value.map((w) => w.id)));
/** The reports this account filed, with their decisions (S3.02). */
const reports = ref<Array<{ receipt: string; category: string; status: string; decision: string; createdAt: string }>>([]);

function failed(error: string): string {
  return error === 'unreachable' ? t('signin.errors.unreachable') : t('signin.errors.failed');
}

async function load(): Promise<void> {
  worlds.value = undefined;
  listError.value = '';
  const [list, favs, mine] = await Promise.all([window.flatchat?.worlds(), window.flatchat?.favourites(), window.flatchat?.reports()]);
  if (favs?.ok) favourites.value = favs.worlds;
  if (mine?.ok) reports.value = mine.reports;
  if (!list || !list.ok) {
    listError.value = failed(list?.error ?? '');
    worlds.value = [];
    return;
  }
  worlds.value = list.worlds;
}

async function toggle(w: FlatchatWorld): Promise<void> {
  const r = await window.flatchat?.setFavourite(w.id, !starred.value.has(w.id));
  if (r?.ok) favourites.value = r.worlds;
}

async function joinById(): Promise<void> {
  byIdError.value = '';
  const id = byId.value.trim().toLowerCase();
  if (!WORLD_ID.test(id)) {
    byIdError.value = t('home.badId');
    return;
  }
  looking.value = true;
  const r = await window.flatchat?.world(id);
  looking.value = false;
  if (!r || !r.ok) {
    byIdError.value = r?.error === 'no-world' ? t('home.noSuchWorld') : failed(r?.error ?? '');
    return;
  }
  if (!r.world.online) {
    byIdError.value = t('home.worldOffline');
    return;
  }
  emit('join', r.world);
}

onMounted(load);
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

      <h2>{{ t('home.byId') }}</h2>
      <form
        class="row"
        @submit.prevent="joinById"
      >
        <input
          v-model="byId"
          type="text"
          class="grow"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('home.idPlaceholder')"
          data-test="world-id"
        >
        <button
          type="submit"
          :disabled="joining !== '' || looking"
          data-test="join-id"
        >
          {{ t('home.go') }}
        </button>
      </form>
      <p
        v-if="byIdError"
        class="error"
        role="alert"
      >
        {{ byIdError }}
      </p>

      <h2>{{ t('home.favourites') }}</h2>
      <p
        v-if="favourites.length === 0"
        class="muted"
      >
        {{ t('home.noFavourites') }}
      </p>
      <ul
        v-else
        class="plain"
        data-test="favourites"
      >
        <WorldRow
          v-for="w in favourites"
          :key="w.id"
          :world="w"
          :favourite="true"
          :joining="joining"
          @join="emit('join', $event)"
          @toggle="toggle"
        />
      </ul>

      <div class="row">
        <h2 class="grow">
          {{ t('home.worlds') }}
        </h2>
        <button
          type="button"
          data-test="refresh"
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
        class="plain"
        data-test="public"
      >
        <WorldRow
          v-for="w in worlds"
          :key="w.id"
          :world="w"
          :favourite="starred.has(w.id)"
          :joining="joining"
          @join="emit('join', $event)"
          @toggle="toggle"
        />
      </ul>
      <p
        v-if="joinError"
        class="error"
        role="alert"
      >
        {{ joinError }}
      </p>
      <template v-if="reports.length > 0">
        <h2>{{ t('home.reports') }}</h2>
        <ul
          class="plain"
          data-test="my-reports"
        >
          <li
            v-for="r in reports"
            :key="r.receipt"
            :data-status="r.status"
          >
            <strong>{{ r.receipt }}</strong> · {{ te(`report.categories.${r.category}`) ? t(`report.categories.${r.category}`) : r.category }} ·
            {{ t(`report.status.${r.status}`) }}
            <span
              v-if="r.decision"
              class="muted"
            > · {{ r.decision }}</span>
          </li>
        </ul>
      </template>
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
</style>

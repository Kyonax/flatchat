<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Settings } from '../../../shared/settings';
import { type Locale, pickLocale } from '../i18n';
import HomeView from './HomeView.vue';
import { loadLayout } from './keys';
import SettingsView from './SettingsView.vue';
import SignIn from './SignIn.vue';
import './theme.css';
import WorldView from './WorldView.vue';

const { t, te, locale } = useI18n();
const bridge = window.flatchat;
const auth = ref<FlatchatAuthState | undefined>(undefined);
const settings = ref<Settings | undefined>(undefined);
const systemLocale = ref('en');
const showSettings = ref(false);
const world = ref<{ world: FlatchatWorld; ticket: { address: string; token: Uint8Array; iceServers: RTCIceServer[] } } | undefined>(undefined);
const joining = ref('');
const joinError = ref('');
let offAuth: (() => void) | undefined;

function applyLocale(): void {
  if (settings.value) locale.value = pickLocale(settings.value.language, systemLocale.value) satisfies Locale;
}

async function change(patch: Partial<Settings>): Promise<void> {
  if (!bridge) return;
  settings.value = await bridge.updateSettings(patch);
  applyLocale();
}

async function join(w: FlatchatWorld): Promise<void> {
  if (!bridge) return;
  joining.value = w.id;
  joinError.value = '';
  const r = await bridge.joinWorld(w.id);
  joining.value = '';
  if (!r.ok) {
    joinError.value = t('home.joinFailed', { reason: te(`home.reasons.${r.error}`) ? t(`home.reasons.${r.error}`) : r.error });
    return;
  }
  world.value = { world: w, ticket: { address: r.address, token: r.token, iceServers: r.iceServers } };
}

onMounted(async () => {
  if (!bridge) return;
  void loadLayout();
  [settings.value, systemLocale.value, auth.value] = await Promise.all([bridge.settings(), bridge.locale(), bridge.authState()]);
  applyLocale();
  offAuth = bridge.onAuth((s) => {
    auth.value = s;
    if (s.status !== 'signed-in') world.value = undefined;
  });
});
onBeforeUnmount(() => offAuth?.());
</script>

<template>
  <div
    v-if="!auth || !settings"
    class="screen"
  >
    <p class="muted">
      {{ t('app.loading') }}
    </p>
  </div>
  <SignIn
    v-else-if="auth.status !== 'signed-in'"
    :state="auth"
    @sign-in="bridge?.signIn()"
    @cancel="bridge?.cancelSignIn()"
  />
  <template v-else>
    <WorldView
      v-if="world"
      :world="world.world"
      :ticket="world.ticket"
      :settings="settings"
      :paused="showSettings"
      @leave="world = undefined"
      @settings="showSettings = true"
      @change="change"
    />
    <HomeView
      v-else-if="!showSettings"
      :account="auth.account"
      :remembered="auth.remembered"
      :joining="joining"
      :join-error="joinError"
      @join="join"
      @settings="showSettings = true"
      @sign-out="bridge?.signOut()"
    />
    <SettingsView
      v-if="showSettings"
      :settings="settings"
      @change="change"
      @back="showSettings = false"
    />
  </template>
</template>

<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Settings } from '../../../shared/settings';
import { type Locale, pickLocale } from '../i18n';
import { setUiVolume, uiSound } from '../world/sounds';
import HomeView from './HomeView.vue';
import OfflineView from './OfflineView.vue';
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
const world = ref<{ world: FlatchatWorld; ticket: { address: string; token: Uint8Array; iceServers: RTCIceServer[]; relayOnly: boolean; local?: boolean; spawn?: string }; visit: number } | undefined>(undefined);
/** Offline mode (S2.13): no core, worlds on this computer. */
const offline = ref(false);
const joining = ref('');
const joinError = ref('');
const travel = ref<{ status: 'going' | 'failed' | 'updating' | 'gpu'; text: string } | undefined>(undefined);
let visits = 0;
let travelling = false;
let offAuth: (() => void) | undefined;

function applyLocale(): void {
  if (settings.value) locale.value = pickLocale(settings.value.language, systemLocale.value) satisfies Locale;
  if (settings.value) setUiVolume(settings.value.sound.ui);
}

/** A soft click for every button the player presses (S2.14). */
function onClick(e: MouseEvent): void {
  if ((e.target as Element | null)?.closest?.('button')) uiSound('click');
}

async function change(patch: Partial<Settings>): Promise<void> {
  if (!bridge) return;
  // A patch built from the reactive settings holds Vue proxies (voice.volumes), which IPC cannot
  // clone: send a plain copy (settings are plain JSON).
  settings.value = await bridge.updateSettings(JSON.parse(JSON.stringify(patch)) as Partial<Settings>);
  applyLocale();
}

async function join(w: FlatchatWorld): Promise<void> {
  if (!bridge) return;
  joining.value = w.id;
  joinError.value = '';
  const r = await bridge.joinWorld(w.id);
  joining.value = '';
  if (!r.ok) {
    joinError.value = t('home.joinFailed', { reason: reason(r.error) });
    return;
  }
  world.value = { world: w, ticket: { address: r.address, token: r.token, iceServers: r.iceServers, relayOnly: r.relayOnly }, visit: (visits += 1) };
}

/** An offline world: started in the main process, joined over IPC with a guest's token. */
async function playOffline(w: { id: string; name: string }): Promise<void> {
  if (!bridge) return;
  joining.value = w.id;
  joinError.value = '';
  const r = await bridge.offlineJoin(w.id);
  joining.value = '';
  if (!r.ok) {
    joinError.value = t('offline.failed', { reason: r.error });
    return;
  }
  const local: FlatchatWorld = { id: w.id, name: r.name, online: true, players: 0, recommended: 1, capacity: 1 };
  world.value = { world: local, ticket: { address: 'local', token: r.token, iceServers: [], relayOnly: false, local: true }, visit: (visits += 1) };
}

function leaveWorld(): void {
  if (world.value?.ticket.local) void bridge?.localClose();
  world.value = undefined;
}

function reason(code: string): string {
  return te(`home.reasons.${code}`) ? t(`home.reasons.${code}`) : code;
}

/** Through a portal (S2.11): the target world's connect token from the core, then the new world;
 *  on any refusal the player stays where they are, told why. */
async function goThrough(to: { world: string; spawn: string }): Promise<void> {
  if (!bridge || travelling) return;
  travelling = true;
  travel.value = { status: 'going', text: '' };
  const fail = (text: string): void => {
    travel.value = { status: 'failed', text };
    setTimeout(() => {
      if (travel.value?.status === 'failed') travel.value = undefined;
    }, 5000);
  };
  try {
    const info = await bridge.world(to.world);
    if (!info.ok) return fail(info.error === 'no-world' ? t('world.portalNowhere') : t('world.portalFailed', { reason: reason(info.error) }));
    if (!info.world.online) return fail(t('world.portalOffline', { world: info.world.name }));
    travel.value = { status: 'going', text: info.world.name };
    const r = await bridge.joinWorld(to.world);
    if (!r.ok) return fail(t('world.portalFailed', { reason: reason(r.error) }));
    world.value = { world: info.world, ticket: { address: r.address, token: r.token, iceServers: r.iceServers, relayOnly: r.relayOnly, ...(to.spawn ? { spawn: to.spawn } : {}) }, visit: (visits += 1) };
    travel.value = undefined;
  } finally {
    travelling = false;
  }
}

/** A world that took a new build restarts on it (S3.06): once it is online again, back in. After
 *  a GPU reset (S6.03, `fast`) the world is still there: back in at once, with a fresh renderer. */
async function rejoin(fast = false): Promise<void> {
  const current = world.value;
  if (!bridge || !current || current.ticket.local || travelling) return;
  travelling = true;
  travel.value = { status: fast ? 'gpu' : 'updating', text: '' };
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, fast && attempt === 0 ? 200 : 3000));
      if (world.value !== current) return;
      const info = await bridge.world(current.world.id);
      if (!info.ok || !info.world.online) continue;
      const r = await bridge.joinWorld(current.world.id);
      if (!r.ok) continue;
      world.value = { world: info.world, ticket: { address: r.address, token: r.token, iceServers: r.iceServers, relayOnly: r.relayOnly }, visit: (visits += 1) };
      travel.value = undefined;
      return;
    }
    travel.value = { status: 'failed', text: t('world.updateFailed') };
  } finally {
    travelling = false;
  }
}

onMounted(async () => {
  if (!bridge) return;
  document.addEventListener('click', onClick);
  void loadLayout();
  [settings.value, systemLocale.value, auth.value] = await Promise.all([bridge.settings(), bridge.locale(), bridge.authState()]);
  applyLocale();
  offAuth = bridge.onAuth((s) => {
    auth.value = s;
    if (s.status !== 'signed-in') world.value = undefined;
  });
});
onBeforeUnmount(() => {
  offAuth?.();
  document.removeEventListener('click', onClick);
});
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
    v-else-if="auth.status !== 'signed-in' && !offline"
    :state="auth"
    @sign-in="bridge?.signIn()"
    @cancel="bridge?.cancelSignIn()"
    @offline="offline = true"
  />
  <template v-else>
    <WorldView
      v-if="world"
      :key="world.visit"
      :world="world.world"
      :ticket="world.ticket"
      :settings="settings"
      :paused="showSettings"
      :travel="travel"
      @leave="leaveWorld"
      @settings="showSettings = true"
      @change="change"
      @travel="goThrough"
      @rejoin="rejoin"
    />
    <OfflineView
      v-else-if="offline && !showSettings"
      :joining="joining"
      :error="joinError"
      @play="playOffline"
      @back="offline = false"
    />
    <HomeView
      v-else-if="!showSettings && auth.status === 'signed-in'"
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

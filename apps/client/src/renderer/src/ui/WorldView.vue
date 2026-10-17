<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { PLAZA } from '@flatchat/sim';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { actionFor, type Settings } from '../../../shared/settings';
import { canGiveTo, type Person, type Role, rolesToGive } from '../world/people';
import { CHAT_MAX, type Travel, WorldSession, type WorldState } from '../world/session';
import { keyLabel } from './keys';
import MicQuestion from './MicQuestion.vue';

const props = defineProps<{
  world: FlatchatWorld;
  ticket: { address: string; token: Uint8Array; iceServers: RTCIceServer[]; relayOnly?: boolean; local?: boolean; spawn?: string };
  settings: Settings;
  paused: boolean;
  /** A portal's journey (S2.11): where to, or why it failed; or the way back into a world that
   *  restarted on a new build (S3.06). */
  travel: { status: 'going' | 'failed' | 'updating'; text: string } | undefined;
}>();
const emit = defineEmits<{ leave: []; settings: []; change: [patch: Partial<Settings>]; travel: [to: Travel]; rejoin: [] }>();
const { t } = useI18n();

const canvas = ref<HTMLCanvasElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const chatOpen = ref(false);
const draft = ref('');
const tooFast = ref(false);
const menu = ref(false);
/** The People panel (S3.06): who is here, their roles, and the roles this player may give. */
const peopleOpen = ref(false);
let session: WorldSession | undefined;
const state = ref<WorldState | undefined>(undefined);
// Set when this world's portal is taking the player away: the leave says `travel`.
let travelling = false;

const asking = computed(() => state.value?.status === 'joined' && !props.settings.voice.asked);
const talkKey = computed(() => props.settings.keys.talk[0] ?? 'KeyT');
const peopleKey = computed(() => props.settings.keys.people[0] ?? 'Tab');
const giving = computed(() => rolesToGive(state.value?.role ?? 'visitor'));
/** A world that took a new build restarts (S3.06): the app brings the player back in. */
const updating = computed(() => state.value?.status === 'lost' && state.value.reason === 'closing' && state.value.detail === 'updating' && !props.ticket.local);
const recent = computed(() => (state.value?.chat ?? []).slice(chatOpen.value ? -14 : -6));
const refusedText = computed(() => {
  const s = state.value;
  if (!s) return '';
  if (s.status === 'refused') return t(`world.refused.${s.reason}`);
  // While the app brings the player back in, its banner speaks; if that fails, this card does.
  if (updating.value && props.travel?.status !== 'failed') return '';
  if (s.status === 'lost' && s.reason === 'download') return t('world.downloadFailed', { reason: s.detail });
  if (s.status === 'lost') return t('world.lost', { reason: s.detail || s.reason });
  return '';
});

/** An entry rule's or a ban's own words (S3.05): the world's text, shown as text. */
const refusedDetail = computed(() => (state.value?.status === 'refused' && (state.value.reason === 'rule' || state.value.reason === 'banned') ? state.value.detail : ''));

function line(l: { from: string; text: string; notice?: 'joined' | 'left' }): string {
  if (l.notice) return t(l.notice === 'joined' ? 'chat.joined' : 'chat.left', { name: l.text });
  return `${l.from}: ${l.text}`;
}

function openChat(): void {
  chatOpen.value = true;
  if (session) session.typing = true;
  session?.unlock();
  void nextTick(() => input.value?.focus());
}

function closeChat(): void {
  chatOpen.value = false;
  draft.value = '';
  if (session) session.typing = false;
}

function send(): void {
  if (!session) return;
  if (!session.say(draft.value)) {
    tooFast.value = true;
    setTimeout(() => (tooFast.value = false), 2000);
    return;
  }
  closeChat();
  session.lock();
}

function onKey(e: KeyboardEvent): void {
  if (chatOpen.value || menu.value || props.paused || state.value?.status !== 'joined') return;
  const action = actionFor(props.settings.keys, e.code);
  if (action === 'chat' && !peopleOpen.value) {
    e.preventDefault();
    openChat();
  } else if (action === 'people' || (peopleOpen.value && e.code === 'Escape')) {
    e.preventDefault();
    togglePeople();
  }
}

/** The People panel frees the mouse to click in it; closing it goes back to looking around. */
function togglePeople(): void {
  peopleOpen.value = !peopleOpen.value;
  if (peopleOpen.value) session?.unlock();
  else session?.lock();
}

function give(p: Person, role: string): void {
  if (giving.value.includes(role as Role)) session?.giveRole(p.account, role as Role);
}

function onLockChange(): void {
  // Esc releases the pointer (the browser's own key): that opens the menu, unless chat or the
  // People panel took it.
  if (!document.pointerLockElement && !chatOpen.value && !peopleOpen.value && state.value?.status === 'joined' && !asking.value) menu.value = true;
}

function look(): void {
  if (state.value?.status !== 'joined' || chatOpen.value || asking.value) return;
  menu.value = false;
  peopleOpen.value = false;
  session?.lock();
}

async function chooseMic(mode: 'open' | 'push'): Promise<void> {
  emit('change', { voice: { ...props.settings.voice, mode, asked: true } });
  await session?.startVoice();
}

onMounted(async () => {
  if (!canvas.value) return;
  session = new WorldSession(canvas.value, PLAZA, props.settings, (s) => {
    const r = reactive(s);
    state.value = r;
    return r;
  });
  session.attach();
  session.onTravel = (to) => {
    travelling = true;
    emit('travel', to);
  };
  window.addEventListener('keydown', onKey);
  document.addEventListener('pointerlockchange', onLockChange);
  await session.start(props.ticket);
  if (state.value?.status === 'joined' && props.settings.voice.asked) await session.startVoice();
});

watch(
  () => props.settings,
  (s) => session?.applySettings(s),
  { deep: true },
);

watch(
  () => props.travel?.status,
  (status) => {
    if (status === 'failed') travelling = false;
  },
);

watch(updating, (now) => {
  if (now) emit('rejoin');
});

watch(
  () => props.paused,
  (paused) => {
    if (paused) session?.unlock();
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerlockchange', onLockChange);
  session?.leave(travelling ? 'travel' : 'quit');
});
</script>

<template>
  <div class="world">
    <canvas
      ref="canvas"
      class="view"
      @click="look"
    />
    <div class="whud top">
      <strong>{{ world.name }}</strong>
      <span
        v-if="state?.status === 'joined'"
        data-test="players"
        :data-players="state.players"
      > · {{ t('world.connected', { n: state.players }) }} · {{ t('world.rtt', { n: state.rttMs }) }}</span>
      <span
        v-if="state?.flying"
        data-test="flying"
      > · {{ t('world.flying') }}</span>
      <span class="muted small"> · {{ t('world.frames', { backend: state?.backend ?? '', n: state?.fps ?? 0 }) }}</span>
    </div>
    <div
      v-if="state?.status === 'joined'"
      hidden
      data-test="sounds"
      :data-playing="state.sounds"
      :data-parts="state.parts"
    />
    <div
      v-if="state?.notice"
      class="whud toast"
      role="status"
      data-test="notice"
    >
      {{ t(`world.${state.notice}`) }}
    </div>
    <div
      v-if="travel"
      class="center whud"
      :class="{ error: travel.status === 'failed' }"
      role="status"
      data-test="travel"
    >
      {{ travel.status === 'updating' ? t('world.updating') : travel.status === 'going' ? (travel.text ? t('world.travelling', { world: travel.text }) : t('world.portalOpening')) : travel.text }}
    </div>
    <div
      v-else-if="state?.status === 'connecting'"
      class="center whud"
      data-test="connecting"
    >
      {{ state.download ? t('world.downloading', { percent: Math.floor((100 * state.download.done) / Math.max(1, state.download.total)) }) : t('world.connecting', { world: world.name }) }}
    </div>
    <div
      v-else-if="state?.status === 'joined' && !state.locked && !chatOpen && !peopleOpen && !menu && !asking && !paused"
      class="center whud hint"
      @click="look"
    >
      {{ t('world.clickToLook') }}
    </div>
    <div
      v-if="refusedText"
      class="center"
    >
      <div class="card">
        <p
          class="error"
          role="alert"
        >
          {{ refusedText }}
        </p>
        <p
          v-if="refusedDetail"
          data-test="refused-detail"
        >
          {{ refusedDetail }}
        </p>
        <button
          type="button"
          class="primary"
          data-test="world-back"
          @click="emit('leave')"
        >
          {{ t('settings.back') }}
        </button>
      </div>
    </div>

    <aside
      v-if="peopleOpen && state?.status === 'joined'"
      class="people card"
      data-test="people"
    >
      <h2>{{ t('people.title', { n: state.people.length }) }}</h2>
      <ul class="plain">
        <li
          v-for="p in state.people"
          :key="p.entity"
          data-test="person"
          :data-role="p.role"
        >
          <span class="name">{{ p.name }}</span>
          <span
            v-if="p.me"
            class="muted small"
          >{{ t('people.you') }}</span>
          <span
            v-if="p.role !== 'visitor'"
            class="badge"
          >{{ t(`roles.${p.role}`) }}</span>
          <select
            v-if="canGiveTo(state.role, p)"
            :value="p.role"
            :aria-label="t('people.giveRole', { name: p.name })"
            data-test="give-role"
            @change="give(p, ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="r in giving"
              :key="r"
              :value="r"
            >
              {{ t(`roles.${r}`) }}
            </option>
          </select>
        </li>
      </ul>
      <p class="muted small">
        {{ t('people.close', { key: keyLabel(peopleKey, t) }) }}
      </p>
    </aside>

    <div
      class="chat"
      :class="{ open: chatOpen }"
    >
      <ul class="plain lines">
        <li
          v-for="l in recent"
          :key="l.id"
          :class="{ notice: l.notice }"
          data-test="chat-line"
        >
          {{ line(l) }}
        </li>
      </ul>
      <form
        v-if="chatOpen"
        @submit.prevent="send"
      >
        <input
          ref="input"
          v-model="draft"
          type="text"
          :maxlength="CHAT_MAX"
          :placeholder="t('chat.placeholder')"
          data-test="chat-input"
          @keydown.esc.prevent="closeChat"
        >
        <span
          v-if="tooFast"
          class="error small"
        >{{ t('chat.tooFast') }}</span>
      </form>
    </div>

    <div
      v-if="state?.status === 'joined' && (state.muted || state.talking || state.voice === 'denied' || (settings.voice.mode === 'push' && state.voice === 'on'))"
      class="voice whud"
    >
      <span
        v-if="state.muted"
        class="error"
      >{{ t('world.muted') }}</span>
      <span
        v-else-if="state.talking"
        class="ok"
      >{{ t('world.talking') }}</span>
      <span
        v-else-if="settings.voice.mode === 'push' && state.voice === 'on'"
        class="muted"
      >{{ t('world.pushToTalk', { key: keyLabel(talkKey, t) }) }}</span>
      <span
        v-else-if="state.voice === 'denied'"
        class="muted"
      >{{ t('mic.noMic') }}</span>
    </div>

    <div
      v-if="menu && !paused"
      class="center"
    >
      <div
        class="card menu"
        role="dialog"
      >
        <h1>{{ t('world.menu') }}</h1>
        <button
          type="button"
          class="primary"
          data-test="resume"
          @click="look"
        >
          {{ t('world.resume') }}
        </button>
        <button
          type="button"
          data-test="world-settings"
          @click="emit('settings')"
        >
          {{ t('home.settings') }}
        </button>
        <button
          type="button"
          data-test="leave"
          @click="emit('leave')"
        >
          {{ t('world.leave') }}
        </button>
      </div>
    </div>

    <MicQuestion
      v-if="asking && !paused"
      :talk-key="talkKey"
      @choose="chooseMic"
    />
  </div>
</template>

<style scoped>
.world {
  position: fixed;
  inset: 0;
  background: var(--bg);
}

.view {
  display: block;
  width: 100%;
  height: 100%;
}

.whud {
  position: absolute;
  padding: 6px 10px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.45);
  color: #f2f2f4;
  pointer-events: none;
}

.top {
  top: 12px;
  left: 12px;
}

.small {
  font-size: 0.85em;
}

.center {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

.center.whud {
  inset: auto;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.hint {
  pointer-events: auto;
  cursor: pointer;
}

.chat {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: min(30rem, calc(100vw - 24px));
  pointer-events: none;
}

.chat.open {
  pointer-events: auto;
}

.lines li {
  margin-top: 2px;
  padding: 2px 8px;
  border-radius: 3px;
  background: rgb(0 0 0 / 0.45);
  color: #f2f2f4;
  overflow-wrap: anywhere;
}

.lines li.notice {
  color: var(--muted);
  font-style: italic;
}

.chat input {
  width: 100%;
  margin-top: 6px;
}

.voice {
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
}

.toast {
  bottom: 56px;
  left: 50%;
  transform: translateX(-50%);
}

.ok {
  color: var(--ok);
}

.menu {
  display: grid;
  gap: 8px;
  width: min(20rem, calc(100vw - 32px));
}

.people {
  position: absolute;
  top: 48px;
  right: 12px;
  width: min(22rem, calc(100vw - 24px));
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}

.people li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}

.people .name {
  overflow-wrap: anywhere;
}

.people select {
  margin-left: auto;
}

.badge {
  padding: 0 6px;
  border-radius: 3px;
  background: var(--accent, #3a6ea5);
  color: #fff;
  font-size: 0.8em;
}
</style>

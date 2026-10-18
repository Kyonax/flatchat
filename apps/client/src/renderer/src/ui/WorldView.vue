<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { PLAZA } from '@flatchat/sim';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { actionFor, type Settings } from '../../../shared/settings';
import { TIER_POLICY } from '../world/avatar-policy';
import { canGiveTo, canModerate, MODERATION, type Person, type Role, rolesToGive } from '../world/people';
import { CHAT_MAX, type Travel, WorldSession, type WorldState } from '../world/session';
import { keyLabel } from './keys';
import BanAppeal from './BanAppeal.vue';
import ReportForm from './ReportForm.vue';
import type { ReportDraft } from '../world/report';
import MicQuestion from './MicQuestion.vue';
import EmoteMenu from './EmoteMenu.vue';
import OutfitMenu from './OutfitMenu.vue';

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
/** The outfits quick menu (S5.05), and the emotes menu (S5.07). */
const outfitsOpen = ref(false);
const emotesOpen = ref(false);
/** The person a moderator is acting on in the panel (S3.07), and the choice and reason. */
const moderating = ref('');
const modChoice = ref<(typeof MODERATION)[number]['id']>('kick');
const modReason = ref('');
/** Who or what the player is reporting (S3.02); the form owns the keys while it is open. */
const reporting = ref<ReportDraft['target'] | undefined>(undefined);
let session: WorldSession | undefined;
const state = ref<WorldState | undefined>(undefined);
// Set when this world's portal is taking the player away: the leave says `travel`.
let travelling = false;

const asking = computed(() => state.value?.status === 'joined' && !props.settings.voice.asked);
const talkKey = computed(() => props.settings.keys.talk[0] ?? 'KeyT');
const peopleKey = computed(() => props.settings.keys.people[0] ?? 'Tab');
const giving = computed(() => rolesToGive(state.value?.role ?? 'visitor'));
/** The People panel's list: someone kept apart by a block is left out, unless this player blocked
 *  them (then they show, to be unblocked) (S3.11). */
const listed = computed(() => (state.value?.people ?? []).filter((p) => !state.value?.hidden.includes(p.entity) || state.value.blocked.includes(p.account)));
const friendError = ref('');

async function friend(p: Person, on: boolean): Promise<void> {
  const error = await session?.befriend(p.account, on);
  friendError.value = error ? t('people.friendFailed', { reason: t(`people.friendErrors.${error}`) }) : '';
}
/** A world that took a new build restarts (S3.06): the app brings the player back in. */
const updating = computed(() => state.value?.status === 'lost' && state.value.reason === 'closing' && state.value.detail === 'updating' && !props.ticket.local);
const recent = computed(() => (state.value?.chat ?? []).slice(chatOpen.value ? -14 : -6));
const refusedText = computed(() => {
  const s = state.value;
  if (!s) return '';
  if (s.status === 'refused') return t(`world.refused.${s.reason}`);
  // While the app brings the player back in, its banner speaks; if that fails, this card does.
  if (updating.value && props.travel?.status !== 'failed') return '';
  // A moderator's removal or ban (S3.07): what happened; the reason follows below.
  if (s.status === 'lost' && s.reason === 'kicked') return t('world.kicked');
  if (s.status === 'lost' && s.reason === 'banned') return t('world.bannedHere');
  if (s.status === 'lost' && s.reason === 'download') return t('world.downloadFailed', { reason: s.detail });
  // The platform took the world down (S3.12).
  if (s.status === 'lost' && s.reason === 'closing' && s.detail === 'revoked') return t('world.revoked');
  if (s.status === 'lost') return t('world.lost', { reason: s.detail || s.reason });
  return '';
});

/** An entry rule's own words (S3.05), or the reason a moderator gave (S3.07): the world's text,
 *  shown as text. */
const refusedDetail = computed(() => {
  const s = state.value;
  if (!s || !s.detail) return '';
  if (s.status === 'refused' && s.reason === 'rule') return s.detail;
  const removed = (s.status === 'refused' && s.reason === 'banned') || (s.status === 'lost' && (s.reason === 'kicked' || s.reason === 'banned'));
  return removed ? t('world.reason', { reason: s.detail }) : '';
});
/** While the menu, the chat box, the People panel or a report is open, keys go to the page (its
 *  buttons and fields), not to the avatar: the session leaves them alone. */
const overlay = computed(() => menu.value || chatOpen.value || peopleOpen.value || outfitsOpen.value || emotesOpen.value || reporting.value !== undefined);

/** Banned here, now or before: the player may appeal to the world's owner (S3.07). */
const banned = computed(() => (state.value?.status === 'refused' || state.value?.status === 'lost') && state.value.reason === 'banned' && !props.ticket.local);

function line(l: { from: string; text: string; notice?: 'joined' | 'left' }): string {
  if (l.notice) return t(l.notice === 'joined' ? 'chat.joined' : 'chat.left', { name: l.text });
  return `${l.from}: ${l.text}`;
}

function openChat(): void {
  chatOpen.value = true;
  session?.unlock();
  void nextTick(() => input.value?.focus());
}

function closeChat(): void {
  chatOpen.value = false;
  draft.value = '';
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
  if (chatOpen.value || menu.value || reporting.value || props.paused || state.value?.status !== 'joined') return;
  const action = actionFor(props.settings.keys, e.code);
  if (action === 'chat' && !peopleOpen.value) {
    e.preventDefault();
    openChat();
  } else if (action === 'people' || (peopleOpen.value && e.code === 'Escape')) {
    e.preventDefault();
    togglePeople();
  } else if (action === 'outfits' || (outfitsOpen.value && e.code === 'Escape')) {
    e.preventDefault();
    toggleOutfits();
  } else if (action === 'emotes' || (emotesOpen.value && e.code === 'Escape')) {
    e.preventDefault();
    toggleEmotes();
  } else if (action === 'menu' && !asking.value) {
    // Esc opens the menu: releasing a held pointer opens it (onLockChange), and with the pointer
    // already free there is no lock to release, so it opens here.
    if (document.pointerLockElement) session?.unlock();
    else menu.value = true;
  }
}

/** The People panel frees the mouse to click in it; closing it goes back to looking around. */
function togglePeople(): void {
  peopleOpen.value = !peopleOpen.value;
  moderating.value = '';
  // Keys go to the panel's fields while it is open, not to the avatar.
  if (peopleOpen.value) session?.unlock();
  else session?.lock();
}

/** The outfits quick menu frees the mouse to click in it, like the People panel. */
function toggleOutfits(): void {
  outfitsOpen.value = !outfitsOpen.value;
  if (outfitsOpen.value) {
    peopleOpen.value = false;
    session?.unlock();
  } else session?.lock();
}

function wearOutfit(items: FlatchatWorn[]): void {
  session?.wearOutfit(items);
}

/** The emotes menu frees the mouse to click in it; a choice plays and closes it. */
function toggleEmotes(): void {
  emotesOpen.value = !emotesOpen.value;
  if (emotesOpen.value) {
    outfitsOpen.value = false;
    peopleOpen.value = false;
    session?.unlock();
  } else session?.lock();
}

function playEmote(anim: string | undefined): void {
  session?.playEmote(anim);
  if (anim) toggleEmotes();
}

// What this account wears goes into the settings by account (S5.05): the next world gets it too.
watch(
  () => JSON.stringify(state.value?.outfit ?? null),
  () => {
    const me = state.value?.people.find((p) => p.me);
    const outfit = state.value?.outfit;
    if (!me || !outfit || JSON.stringify(props.settings.avatar.worn[me.account] ?? []) === JSON.stringify(outfit)) return;
    emit('change', { avatar: { ...props.settings.avatar, worn: { ...props.settings.avatar.worn, [me.account]: outfit } } });
  },
);

function startModerating(p: Person): void {
  moderating.value = moderating.value === p.account ? '' : p.account;
  modChoice.value = 'kick';
  modReason.value = '';
}

function startReport(target: ReportDraft['target']): void {
  reporting.value = target;
  peopleOpen.value = false;
  menu.value = false;
  session?.unlock();
}

function endReport(): void {
  reporting.value = undefined;
}

/** Builds the report with this visit's evidence and sends it through the core. */
async function fileReport(draft: ReportDraft): Promise<{ ok: true; receipt: string } | { ok: false; error: string }> {
  const bridge = window.flatchat;
  if (!session || !bridge) return { ok: false, error: 'failed' };
  return bridge.report(session.reportOf(draft, props.ticket.address));
}

/** This player's volume for one person (S3.08), kept in the settings by account. */
function volumeOf(p: Person): number {
  return Math.round((props.settings.voice.volumes[p.account] ?? 1) * 100);
}

/** Hides or shows a person's avatar on this screen (S4.09): hidden, it shows as the impostor. */
function toggleAvatar(p: Person): void {
  const hidden = props.settings.avatar.hidden;
  emit('change', { avatar: { ...props.settings.avatar, hidden: hidden.includes(p.account) ? hidden.filter((a) => a !== p.account) : [...hidden, p.account] } });
}

// The first visit's measurement (S4.05) goes into the settings, with its tier's defaults.
watch(
  () => state.value?.measuredTier,
  (tier) => {
    if (!tier || props.settings.avatar.tier !== 'unset') return;
    emit('change', { avatar: { ...props.settings.avatar, tier, full: TIER_POLICY[tier].full, minRank: TIER_POLICY[tier].minRank } });
  },
);

function setVolume(p: Person, percent: number): void {
  emit('change', { voice: { ...props.settings.voice, volumes: { ...props.settings.voice.volumes, [p.account]: Math.min(2, Math.max(0, percent / 100)) } } });
}

function applyModeration(p: Person): void {
  const m = MODERATION.find((x) => x.id === modChoice.value);
  if (!m || (m.action !== 'unmute' && !modReason.value.trim())) return;
  session?.moderate(p.account, m.action, m.minutes, modReason.value.trim());
  moderating.value = '';
}

function give(p: Person, role: string): void {
  if (giving.value.includes(role as Role)) session?.giveRole(p.account, role as Role);
}

function onLockChange(): void {
  // Esc releases the pointer (the browser's own key): that opens the menu, unless chat, the
  // People panel or a report took it.
  if (!document.pointerLockElement && !chatOpen.value && !peopleOpen.value && !outfitsOpen.value && !emotesOpen.value && !reporting.value && state.value?.status === 'joined' && !asking.value) menu.value = true;
}

function look(): void {
  if (state.value?.status !== 'joined' || chatOpen.value || asking.value) return;
  menu.value = false;
  peopleOpen.value = false;
  outfitsOpen.value = false;
  emotesOpen.value = false;
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
  // What follows the account (S3.08, S3.10, S3.11): mutes, friends, blocks; an offline guest has none.
  if (state.value?.status === 'joined' && !props.ticket.local) await session.loadSocial();
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

watch(overlay, (open) => {
  if (session) session.typing = open;
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
      :data-footsteps="state.footsteps"
      :data-parts="state.parts"
    />
    <span
      v-if="state?.status === 'joined'"
      hidden
      data-test="avatar-counts"
      :data-lod0="state.avatars.lod0"
      :data-lod1="state.avatars.lod1"
      :data-lod2="state.avatars.lod2"
      :data-impostor="state.avatars.impostor"
    />
    <span
      v-if="state?.status === 'joined'"
      hidden
      data-test="outfit"
      :data-items="state.outfit.length"
      :data-dressed="state.dressed"
    />
    <span
      v-if="state?.status === 'joined'"
      hidden
      data-test="effects"
      :data-playing="state.effects.playing"
      :data-world="state.effects.world"
      :data-instances="state.effects.instances"
      :data-refused="state.effects.refused"
      :data-stopped="state.effects.stopped"
      :data-depth="state.effects.depth"
      :data-backend="state.effects.backend"
      :data-failed="state.effects.failed"
    />
    <span
      v-if="state?.status === 'joined'"
      hidden
      data-test="emote"
      :data-anim="state.emote"
      :data-playing="state.emoting ? 1 : 0"
      :data-sounds="state.emoteSounds"
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
      v-else-if="state?.status === 'joined' && !state.locked && !chatOpen && !peopleOpen && !outfitsOpen && !emotesOpen && !menu && !asking && !paused"
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
        <BanAppeal
          v-if="banned"
          :world-id="world.id"
          :reason="state?.detail ?? ''"
        />
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

    <div
      v-if="state?.status === 'joined' && state.heldMute !== undefined"
      class="whud held error"
      role="status"
      data-test="held-mute"
    >
      {{ t('world.heldMute') }}{{ state.heldMute ? ` · ${t('world.reason', { reason: state.heldMute })}` : '' }}
    </div>

    <EmoteMenu
      v-if="emotesOpen && state?.status === 'joined'"
      :playing="state.emote"
      @play="playEmote"
      @close="toggleEmotes"
    />
    <OutfitMenu
      v-if="outfitsOpen && state?.status === 'joined'"
      :outfit="state.outfit"
      @wear="wearOutfit"
      @close="toggleOutfits"
    />
    <aside
      v-if="peopleOpen && state?.status === 'joined'"
      class="people card"
      data-test="people"
    >
      <h2>{{ t('people.title', { n: state.people.length }) }}</h2>
      <ul class="plain">
        <li
          v-for="p in listed"
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
          <span
            v-if="state.friends.includes(p.account)"
            class="badge friend"
            data-test="friend-badge"
          >{{ t('people.friend') }}</span>
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
          <button
            v-if="canModerate(state.role, p)"
            type="button"
            class="small"
            data-test="moderate"
            @click="startModerating(p)"
          >
            {{ t('people.moderate') }}
          </button>
          <template v-if="!p.me">
            <button
              type="button"
              class="small"
              data-test="hide-avatar"
              :data-on="settings.avatar.hidden.includes(p.account)"
              @click="toggleAvatar(p)"
            >
              {{ settings.avatar.hidden.includes(p.account) ? t('people.showAvatar') : t('people.hideAvatar') }}
            </button>
            <button
              v-if="!ticket.local"
              type="button"
              class="small"
              data-test="personal-mute"
              :data-on="state.silenced.includes(p.account)"
              @click="session?.setPersonalMute(p.account, !state.silenced.includes(p.account))"
            >
              {{ state.silenced.includes(p.account) ? t('people.unmute') : t('people.mute') }}
            </button>
            <input
              type="range"
              min="0"
              max="200"
              step="10"
              :value="volumeOf(p)"
              :aria-label="t('people.volume', { name: p.name })"
              data-test="person-volume"
              @change="setVolume(p, Number(($event.target as HTMLInputElement).value))"
            >
          </template>
          <template v-if="!p.me && !ticket.local">
            <button
              v-if="state.blocked.includes(p.account)"
              type="button"
              class="small"
              data-test="unblock"
              @click="session?.block(p.account, false)"
            >
              {{ t('people.unblock') }}
            </button>
            <template v-else>
              <button
                v-if="state.incoming.includes(p.account)"
                type="button"
                class="small primary"
                data-test="accept-friend"
                @click="friend(p, true)"
              >
                {{ t('people.accept') }}
              </button>
              <button
                v-else-if="!state.friends.includes(p.account) && !state.outgoing.includes(p.account)"
                type="button"
                class="small"
                data-test="add-friend"
                @click="friend(p, true)"
              >
                {{ t('people.addFriend') }}
              </button>
              <span
                v-else-if="state.outgoing.includes(p.account)"
                class="muted small"
              >{{ t('people.asked') }}</span>
              <button
                type="button"
                class="small"
                data-test="block"
                @click="session?.block(p.account, true)"
              >
                {{ t('people.block') }}
              </button>
            </template>
          </template>
          <button
            v-if="!p.me && !ticket.local"
            type="button"
            class="small"
            data-test="report-person"
            @click="startReport({ kind: 'player', account: p.account, name: p.name })"
          >
            {{ t('report.button') }}
          </button>
          <form
            v-if="moderating === p.account"
            class="moderate"
            @submit.prevent="applyModeration(p)"
          >
            <select
              v-model="modChoice"
              :aria-label="t('people.action', { name: p.name })"
              data-test="mod-action"
            >
              <option
                v-for="m in MODERATION"
                :key="m.id"
                :value="m.id"
              >
                {{ t(`moderation.${m.id}`) }}
              </option>
            </select>
            <input
              v-model="modReason"
              type="text"
              maxlength="160"
              :placeholder="t('people.reason')"
              data-test="mod-reason"
            >
            <button
              type="submit"
              class="primary"
              :disabled="modChoice !== 'unmute' && !modReason.trim()"
              data-test="mod-apply"
            >
              {{ t('people.apply') }}
            </button>
          </form>
        </li>
      </ul>
      <p
        v-if="friendError"
        class="error small"
      >
        {{ friendError }}
      </p>
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
      v-if="state?.status === 'joined' && (state.muted || state.earmuffs || state.talking || state.voice === 'denied' || (settings.voice.mode === 'push' && state.voice === 'on'))"
      class="voice whud"
    >
      <span
        v-if="state.earmuffs"
        data-test="earmuffs"
      >{{ t('world.earmuffs') }} · </span>
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
          v-if="!ticket.local"
          type="button"
          data-test="report-world"
          @click="startReport({ kind: 'world', world: world.id, name: world.name })"
        >
          {{ t('report.thisWorld') }}
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

    <ReportForm
      v-if="reporting"
      :target="reporting"
      :file="fileReport"
      @close="endReport"
    />

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

.people form.moderate {
  display: grid;
  gap: 4px;
  width: 100%;
}

.held {
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
}

.badge.friend {
  background: var(--ok, #2e7d32);
}

.badge {
  padding: 0 6px;
  border-radius: 3px;
  background: var(--accent, #3a6ea5);
  color: #fff;
  font-size: 0.8em;
}
</style>

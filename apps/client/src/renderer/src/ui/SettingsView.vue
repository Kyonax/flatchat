<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ACTIONS, type Action, bind, DEFAULT_KEYS, FIXED, HEIGHT_RANGE, PROPORTION_RANGE, RANK_CHOICES, type Settings, unbind, validCode } from '../../../shared/settings';
import { keyLabel, mouseCode } from './keys';

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ change: [patch: Partial<Settings>]; back: [] }>();
const { t } = useI18n();

/** The slot waiting for a key, if any. */
const capturing = ref<{ action: Action; slot: 0 | 1 } | undefined>(undefined);
const devices = ref<Array<{ id: string; label: string }>>([]);

function take(code: string): void {
  const c = capturing.value;
  if (!c) return;
  capturing.value = undefined;
  if (code === 'Escape' || !validCode(code)) return;
  emit('change', { keys: bind(props.settings.keys, c.action, c.slot, code) });
}

function onKey(e: KeyboardEvent): void {
  if (!capturing.value) return;
  e.preventDefault();
  e.stopPropagation();
  take(e.code);
}

function onMouse(e: MouseEvent): void {
  if (!capturing.value) return;
  // The click that opened the capture is not a binding.
  if ((e.target as HTMLElement | null)?.closest('[data-slot]')) return;
  e.preventDefault();
  take(mouseCode(e.button));
}

onMounted(async () => {
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    devices.value = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== '').map((d) => ({ id: d.deviceId, label: d.label || d.deviceId.slice(0, 8) }));
  } catch {
    devices.value = [];
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('mousedown', onMouse, true);
});

const fixed = (a: Action): boolean => FIXED.includes(a);
const slotText = (a: Action, slot: 0 | 1): string => {
  if (capturing.value?.action === a && capturing.value.slot === slot) return t('settings.pressKey');
  const code = props.settings.keys[a][slot];
  return code ? keyLabel(code, t) : t('settings.unbound');
};
const resetKeys = (): void => emit('change', { keys: Object.fromEntries(ACTIONS.map((a) => [a, [...DEFAULT_KEYS[a]]])) as Settings['keys'] });
const clear = (a: Action, slot: 0 | 1): void => emit('change', { keys: unbind(props.settings.keys, a, slot) });
const voice = (patch: Partial<Settings['voice']>): void => emit('change', { voice: { ...props.settings.voice, ...patch } });
const view = (patch: Partial<Settings['view']>): void => emit('change', { view: { ...props.settings.view, ...patch } });
const avatar = (patch: Partial<Settings['avatar']>): void => emit('change', { avatar: { ...props.settings.avatar, ...patch } });
const sound = (patch: Partial<Settings['sound']>): void => emit('change', { sound: { ...props.settings.sound, ...patch } });
const serverDraft = ref(props.settings.core);
const serverBad = ref(false);
function saveServer(): void {
  const text = serverDraft.value.trim();
  let ok = text === '';
  try {
    const u = new URL(text);
    ok ||= u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
  } catch {
    // not a URL
  }
  serverBad.value = !ok;
  if (ok) emit('change', { core: text });
}
const num = (e: Event): number => Number((e.target as HTMLInputElement).value);
const str = (e: Event): string => (e.target as HTMLSelectElement).value;
</script>

<template>
  <div class="screen">
    <div class="card settings">
      <div class="row">
        <h1 class="grow">
          {{ t('settings.title') }}
        </h1>
        <button
          type="button"
          data-test="back"
          @click="emit('back')"
        >
          {{ t('settings.back') }}
        </button>
      </div>

      <h2>{{ t('settings.language') }}</h2>
      <select
        :value="settings.language"
        data-test="language"
        @change="emit('change', { language: str($event) as Settings['language'] })"
      >
        <option value="system">
          {{ t('settings.languages.system') }}
        </option>
        <option value="en">
          {{ t('settings.languages.en') }}
        </option>
        <option value="es">
          {{ t('settings.languages.es') }}
        </option>
      </select>

      <h2>{{ t('settings.controls') }}</h2>
      <table class="keys">
        <tbody>
          <tr
            v-for="a in ACTIONS"
            :key="a"
          >
            <th scope="row">
              {{ t(`actions.${a}`) }}
            </th>
            <td
              v-for="slot in [0, 1] as const"
              :key="slot"
            >
              <button
                type="button"
                class="slot"
                data-slot
                :disabled="fixed(a)"
                :aria-pressed="capturing?.action === a && capturing.slot === slot"
                @click="capturing = { action: a, slot }"
                @contextmenu.prevent="clear(a, slot)"
              >
                {{ slotText(a, slot) }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <button
        type="button"
        @click="resetKeys"
      >
        {{ t('settings.reset') }}
      </button>

      <h2>{{ t('settings.view') }}</h2>
      <div class="row">
        <select
          :value="settings.view.person"
          @change="view({ person: str($event) as 'first' | 'third' })"
        >
          <option value="third">
            {{ t('settings.person.third') }}
          </option>
          <option value="first">
            {{ t('settings.person.first') }}
          </option>
        </select>
      </div>
      <label class="row">
        <span class="grow">{{ t('settings.sensitivity') }}</span>
        <input
          type="range"
          min="1"
          max="60"
          :value="settings.view.sensitivity"
          @change="view({ sensitivity: num($event) })"
        >
      </label>
      <label class="row">
        <input
          type="checkbox"
          :checked="settings.view.invertY"
          @change="view({ invertY: ($event.target as HTMLInputElement).checked })"
        >
        <span>{{ t('settings.invertY') }}</span>
      </label>

      <h2>{{ t('settings.avatar') }}</h2>
      <label class="row">
        <span class="grow">{{ t('settings.height', { m: settings.avatar.height.toFixed(2) }) }}</span>
        <input
          type="range"
          :min="HEIGHT_RANGE.min"
          :max="HEIGHT_RANGE.max"
          step="0.05"
          :value="settings.avatar.height"
          data-test="height"
          @change="avatar({ height: num($event) })"
        >
      </label>
      <p class="muted small">
        {{ t('settings.heightHint') }}
      </p>
      <label
        v-for="k in (['width', 'arms', 'legs', 'head'] as const)"
        :key="k"
        class="row"
      >
        <span class="grow">{{ t(`settings.proportions.${k}`, { p: Math.round(settings.avatar.proportions[k] * 100) }) }}</span>
        <input
          type="range"
          :min="PROPORTION_RANGE.min"
          :max="PROPORTION_RANGE.max"
          step="0.05"
          :value="settings.avatar.proportions[k]"
          :data-test="`proportion-${k}`"
          @change="avatar({ proportions: { ...settings.avatar.proportions, [k]: num($event) } })"
        >
      </label>

      <h2>{{ t('settings.avatars') }}</h2>
      <p class="muted small">
        {{ settings.avatar.tier === 'unset' ? t('settings.tierUnset') : t('settings.tier', { tier: t(`settings.tiers.${settings.avatar.tier}`) }) }}
        <button
          v-if="settings.avatar.tier !== 'unset'"
          type="button"
          class="small"
          data-test="measure-again"
          @click="avatar({ tier: 'unset' })"
        >
          {{ t('settings.measureAgain') }}
        </button>
      </p>
      <label class="row">
        <span class="grow">{{ t('settings.fullAvatars', { n: settings.avatar.full }) }}</span>
        <input
          type="range"
          min="0"
          max="24"
          step="1"
          :value="settings.avatar.full"
          data-test="full-avatars"
          @change="avatar({ full: num($event) })"
        >
      </label>
      <label class="row">
        <span class="grow">{{ t('settings.minRank') }}</span>
        <select
          :value="settings.avatar.minRank"
          data-test="min-rank"
          @change="avatar({ minRank: str($event) as Settings['avatar']['minRank'] })"
        >
          <option
            v-for="r in RANK_CHOICES"
            :key="r"
            :value="r"
          >
            {{ t(`avatars.rank.${r}`) }}
          </option>
        </select>
      </label>
      <label class="row">
        <span class="grow">{{ t('settings.shield') }}</span>
        <select
          :value="settings.avatar.shield"
          data-test="shield"
          @change="avatar({ shield: Number(str($event)) })"
        >
          <option
            v-for="n in [0, 1, 2, 3, 4]"
            :key="n"
            :value="n"
          >
            {{ n === 0 ? t('settings.shieldOff') : t('settings.shieldLevel', { n }) }}
          </option>
        </select>
      </label>
      <label class="row">
        <input
          type="checkbox"
          :checked="settings.avatar.autoTune"
          data-test="auto-tune"
          @change="avatar({ autoTune: ($event.target as HTMLInputElement).checked })"
        >
        <span>{{ t('settings.autoTune') }}</span>
      </label>

      <h2>{{ t('settings.voice') }}</h2>
      <div class="row">
        <select
          :value="settings.voice.mode"
          data-test="voice-mode"
          @change="voice({ mode: str($event) as 'open' | 'push', asked: true })"
        >
          <option value="open">
            {{ t('settings.mode.open') }}
          </option>
          <option value="push">
            {{ t('settings.mode.push') }}
          </option>
        </select>
      </div>
      <label class="row">
        <span class="grow">{{ t('settings.inputDevice') }}</span>
        <select
          :value="settings.voice.inputDevice"
          @change="voice({ inputDevice: str($event) })"
        >
          <option value="">
            {{ t('settings.defaultDevice') }}
          </option>
          <option
            v-for="d in devices"
            :key="d.id"
            :value="d.id"
          >
            {{ d.label }}
          </option>
        </select>
      </label>
      <label class="row">
        <span class="grow">{{ t('settings.volume') }}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="settings.voice.volume"
          @change="voice({ volume: num($event) })"
        >
      </label>
      <h2>{{ t('settings.sound') }}</h2>
      <label class="row">
        <span class="grow">{{ t('settings.worldVolume') }}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="settings.sound.world"
          data-test="world-volume"
          @change="sound({ world: num($event) })"
        >
      </label>
      <label class="row">
        <span class="grow">{{ t('settings.uiVolume') }}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="settings.sound.ui"
          @change="sound({ ui: num($event) })"
        >
      </label>
      <h2>{{ t('settings.server') }}</h2>
      <div class="row">
        <input
          v-model="serverDraft"
          type="text"
          class="grow"
          :placeholder="t('settings.serverPlaceholder')"
          data-test="server"
          @change="saveServer"
        >
      </div>
      <p
        :class="serverBad ? 'error' : 'muted'"
      >
        {{ serverBad ? t('settings.serverInvalid') : t('settings.serverHint') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: min(40rem, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow: auto;
}

h2 {
  font-size: 1.05rem;
  margin: 20px 0 8px;
}

.keys {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 8px;
}

.keys th {
  text-align: left;
  font-weight: 400;
  padding: 4px 8px 4px 0;
}

.keys td {
  padding: 2px 4px;
  width: 9rem;
}

.slot {
  width: 100%;
  padding: 4px 8px;
}

.slot[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
}

label.row {
  margin: 8px 0;
}
</style>

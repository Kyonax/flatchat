// SPDX-License-Identifier: MPL-2.0
// The client's two languages (Q-H2), through vue-i18n's composition API. Messages are plain data:
// vue-i18n compiles them without eval, so the page's policy stays strict.
import { createI18n } from 'vue-i18n';
import en from './en';
import es from './es';

export type Locale = 'en' | 'es';
export type MessageSchema = typeof en;

export const LOCALES: readonly Locale[] = ['en', 'es'];

/** The language to show: the player's choice, else the system's when it is Spanish, else English. */
export function pickLocale(choice: 'system' | Locale, system: string): Locale {
  if (choice !== 'system') return choice;
  return system.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function makeI18n(locale: Locale) {
  return createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, es } as Record<Locale, MessageSchema> });
}

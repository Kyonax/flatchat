// SPDX-License-Identifier: MPL-2.0
import { createApp } from 'vue';
import App from './App.vue';
import { makeI18n } from './i18n';

// English first; the app switches to the player's language once its settings are read.
createApp(App).use(makeI18n('en')).mount('#app');

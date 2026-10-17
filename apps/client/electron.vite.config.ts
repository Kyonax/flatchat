// SPDX-License-Identifier: MPL-2.0
// electron-vite builds the main process, the preload script and the renderer (Vite 8) into out/.
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [vue()],
    // vue-i18n's build flags: the composition API only, messages compiled without eval (the page's
    // policy has no 'unsafe-eval'), no devtools hooks in a packaged client.
    define: {
      __VUE_I18N_FULL_INSTALL__: false,
      __VUE_I18N_LEGACY_API__: false,
      __INTLIFY_JIT_COMPILATION__: true,
      __INTLIFY_DROP_MESSAGE_COMPILER__: false,
      __INTLIFY_PROD_DEVTOOLS__: false,
    },
  },
});

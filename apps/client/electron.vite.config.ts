// SPDX-License-Identifier: MPL-2.0
// electron-vite builds the main process, the preload script and the renderer (Vite 8) into out/.
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [vue()],
  },
});

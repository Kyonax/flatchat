// SPDX-License-Identifier: MPL-2.0
// Lint rules for every workspace: ESLint's and typescript-eslint's recommended sets, plus Vue's.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', '**/out/', '**/release/', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);

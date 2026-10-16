// SPDX-License-Identifier: MPL-2.0
/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface FlatchatBridge {
  versions: { electron: string; chrome: string; node: string };
  smokeReport(report: unknown): Promise<void>;
  benchReport(report: unknown): Promise<void>;
}

interface Window {
  flatchat?: FlatchatBridge;
}

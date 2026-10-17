// SPDX-License-Identifier: MPL-2.0
// The settings file in the app's data folder: read once, cleaned (src/shared/settings.ts), and
// written whole to a temporary file then renamed, so a crash never leaves half a file.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cleanSettings, mergeSettings, type Settings } from '../shared/settings';

export class SettingsFile {
  private readonly path: string;
  private value: Settings;

  constructor(path: string) {
    this.path = path;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      raw = undefined;
    }
    this.value = cleanSettings(raw);
  }

  get(): Settings {
    return this.value;
  }

  update(patch: unknown): Settings {
    this.value = mergeSettings(this.value, patch);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    return this.value;
  }
}

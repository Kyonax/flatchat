// SPDX-License-Identifier: MPL-2.0
// The platform's default sounds (Track P's P.06, kits/sounds/): ten recorded footsteps and three
// interface sounds (a button's click, a chime when someone arrives, a blip for a chat line), from
// Kenney's CC0 packs, carried inside the client (inlined, as the default clips are) and decoded
// once for each audio context that plays them.
import blip from '../../../../../../kits/sounds/ui/blip.ogg?url&inline';
import chime from '../../../../../../kits/sounds/ui/chime.ogg?url&inline';
import click from '../../../../../../kits/sounds/ui/click.ogg?url&inline';
import f0 from '../../../../../../kits/sounds/footsteps/footstep0.ogg?url&inline';
import f1 from '../../../../../../kits/sounds/footsteps/footstep1.ogg?url&inline';
import f2 from '../../../../../../kits/sounds/footsteps/footstep2.ogg?url&inline';
import f3 from '../../../../../../kits/sounds/footsteps/footstep3.ogg?url&inline';
import f4 from '../../../../../../kits/sounds/footsteps/footstep4.ogg?url&inline';
import f5 from '../../../../../../kits/sounds/footsteps/footstep5.ogg?url&inline';
import f6 from '../../../../../../kits/sounds/footsteps/footstep6.ogg?url&inline';
import f7 from '../../../../../../kits/sounds/footsteps/footstep7.ogg?url&inline';
import f8 from '../../../../../../kits/sounds/footsteps/footstep8.ogg?url&inline';
import f9 from '../../../../../../kits/sounds/footsteps/footstep9.ogg?url&inline';

export type UiSoundKind = 'click' | 'chime' | 'blip';
export const UI_SOUNDS: Readonly<Record<UiSoundKind, string>> = { click, chime, blip };
export const FOOTSTEPS: readonly string[] = [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9];

/** An inlined file's bytes (a data URL). */
export function soundBytes(url: string): ArrayBuffer {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

/** The sounds decoded for one audio context, each once; one that will not decode stays silent. */
export class SoundBank {
  private readonly ctx: Pick<BaseAudioContext, 'decodeAudioData'>;
  private readonly decoded = new Map<string, AudioBuffer | null>();

  constructor(ctx: Pick<BaseAudioContext, 'decodeAudioData'>) {
    this.ctx = ctx;
  }

  /** Decodes these sounds now, so each plays at once when it is wanted. */
  async load(urls: readonly string[]): Promise<void> {
    await Promise.all(
      urls.map(async (url) => {
        if (this.decoded.has(url)) return;
        this.decoded.set(url, null);
        try {
          this.decoded.set(url, await this.ctx.decodeAudioData(soundBytes(url)));
        } catch {
          // Stays null: silent.
        }
      }),
    );
  }

  /** A decoded sound, when it is ready. */
  get(url: string): AudioBuffer | undefined {
    return this.decoded.get(url) ?? undefined;
  }
}

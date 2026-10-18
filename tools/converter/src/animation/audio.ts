// SPDX-License-Identifier: MPL-2.0
// An emote's or a dance's sound (S5.07): WAV (PCM or float) or Ogg (Vorbis or Opus), read only as
// far as its type and length. Nothing decodes the samples here: the client's Web Audio does, and
// Rhubarb reads the file on the core for the mouth track.
import { ANIMATION_AUDIO_LIMIT, ANIMATION_MAX_SECONDS, type AnimationAudioType } from '@flatchat/content';

export class AudioError extends Error {}

const text = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** A WAV's length from its fmt and data chunks. */
function wav(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let rate = 0;
  let frame = 0;
  let data = -1;
  while (at + 8 <= b.length) {
    const id = text(b, at, 4);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ' && size >= 16) {
      const format = v.getUint16(at + 8, true);
      const channels = v.getUint16(at + 10, true);
      rate = v.getUint32(at + 12, true);
      const bits = v.getUint16(at + 22, true);
      if (format !== 1 && format !== 3 && format !== 0xfffe) throw new AudioError('a WAV of PCM or float samples');
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 96_000 || (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32)) throw new AudioError('a WAV of one or two channels, 8 to 96 kHz');
      frame = channels * (bits / 8);
    } else if (id === 'data') {
      data = Math.min(size, b.length - at - 8);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!rate || !frame || data < 0) throw new AudioError('the WAV has no format or no samples');
  return data / frame / rate;
}

/** An Ogg's length from its first page's codec header and its last page's granule position. */
function ogg(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // The first page's packet: Vorbis's identification header or Opus's head.
  const segments = b[26] ?? 0;
  const body = 27 + segments;
  let rate: number;
  let skip = 0;
  if (b[body] === 1 && text(b, body + 1, 6) === 'vorbis') rate = v.getUint32(body + 12, true);
  else if (text(b, body, 8) === 'OpusHead') {
    rate = 48_000;
    skip = v.getUint16(body + 10, true);
  } else throw new AudioError('an Ogg of Vorbis or Opus');
  if (!(rate > 0)) throw new AudioError('the Ogg has no sample rate');
  // The last page: search back for its capture pattern.
  for (let at = b.length - 27; at >= 0; at--) {
    if (b[at] === 0x4f && text(b, at, 4) === 'OggS') {
      const granule = Number(v.getBigUint64(at + 6, true));
      return Math.max(0, granule - skip) / rate;
    }
  }
  throw new AudioError('the Ogg has no last page');
}

/** A sound's type and length in seconds, or why it is not one the platform plays. */
export function readAudio(b: Uint8Array): { type: AnimationAudioType; duration: number } {
  if (b.length > ANIMATION_AUDIO_LIMIT) throw new AudioError(`the sound is ${(b.length / 1048576).toFixed(1)} MB: ${ANIMATION_AUDIO_LIMIT / 1048576} MB at most`);
  let type: AnimationAudioType;
  let duration: number;
  if (b.length >= 44 && text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WAVE') {
    type = 'audio/wav';
    duration = wav(b);
  } else if (b.length >= 28 && text(b, 0, 4) === 'OggS') {
    type = 'audio/ogg';
    duration = ogg(b);
  } else throw new AudioError('not a sound FlatChat plays: a WAV or an Ogg (Vorbis or Opus)');
  if (!(duration > 0)) throw new AudioError('the sound is empty');
  if (duration > ANIMATION_MAX_SECONDS) throw new AudioError(`the sound is ${duration.toFixed(1)} s: ${ANIMATION_MAX_SECONDS} s at most`);
  return { type, duration: Math.round(duration * 1000) / 1000 };
}

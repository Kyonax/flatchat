// SPDX-License-Identifier: MPL-2.0
// The devlog view of a run (spike S0.07): a top-down map of every bot, the ones talking lit up,
// one player's interest cells shaded (near: full at 20 Hz; the ring: full at 5 Hz) with its voice
// range, and the run's numbers beside it. It reads the server's trace (every player's position
// four times a second), draws 1280×720 frames at 30 fps in plain JavaScript, and pipes them to
// ffmpeg for an H.264 MP4; one frame is also written as a PNG. Output: DIR/devlog.mp4, DIR/devlog.png.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const W = 1280;
const H = 720;
const FPS = 30;
const CELL = 32;

type RGB = [number, number, number];
const BG: RGB = [11, 13, 16];
const GRID: RGB = [26, 32, 46];
const NEAR: RGB = [22, 48, 70];
const RING: RGB = [16, 31, 44];
const IDLE: RGB = [107, 122, 144];
const TALK: RGB = [249, 205, 38];
const TEXT: RGB = [216, 222, 233];
const DIM: RGB = [120, 132, 150];
const WHITE: RGB = [255, 255, 255];

// 5×7 glyphs, one number per row, the high bit on the left.
const GLYPHS: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ':': [0, 12, 12, 0, 12, 12, 0], '/': [1, 2, 2, 4, 8, 8, 16],
  '+': [0, 4, 4, 31, 4, 4, 0], '-': [0, 0, 0, 31, 0, 0, 0], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '%': [24, 25, 2, 4, 8, 19, 3], ',': [0, 0, 0, 0, 12, 4, 8], '·': [0, 0, 0, 12, 12, 0, 0], '=': [0, 0, 31, 0, 31, 0, 0],
};

class Canvas {
  readonly px = Buffer.alloc(W * H * 3);

  clear(c: RGB): void {
    for (let i = 0; i < W * H; i++) this.px.set(c, i * 3);
  }

  dot(x: number, y: number, c: RGB, alpha = 1): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round((this.px[i + k] ?? 0) * (1 - alpha) + c[k]! * alpha);
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGB): void {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y0 + h)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x0 + w)); x++) this.px.set(c, (y * W + x) * 3);
    }
  }

  disc(cx: number, cy: number, r: number, c: RGB, alpha = 1): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) this.dot(x, y, c, alpha * Math.min(1, r - d + 0.5));
      }
    }
  }

  ring(cx: number, cy: number, r: number, c: RGB, alpha = 1, width = 1.2): void {
    for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++) {
      for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
        const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
        if (d <= width) this.dot(x, y, c, alpha * (1 - d / width));
      }
    }
  }

  text(x: number, y: number, s: string, c: RGB, scale = 2): number {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[' ']!;
      g.forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx++) if (row & (16 >> rx)) this.rect(cx + rx * scale, y + ry * scale, scale, scale, c);
      });
      cx += 6 * scale;
    }
    return cx;
  }
}

interface Frame {
  t: number;
  players: Array<[number, number, number, 0 | 1]>;
}

function png(canvas: Canvas): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) canvas.px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function renderRun(dir: string, fromS: number, seconds: number): Promise<number> {
  const tracePath = join(dir, 'trace.jsonl');
  if (!existsSync(tracePath)) {
    process.stderr.write(`render: no trace in ${dir} (run with --trace)\n`);
    return 2;
  }
  const frames = readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Frame);
  const server = readFileSync(join(dir, 'server.jsonl'), 'utf8').split('\n').filter((l) => l.startsWith('{'));
  const ready = JSON.parse(server[0] ?? '{}') as Record<string, unknown>;
  const size = Number(ready['worldSize'] ?? 256);
  const transport = ready['transports'] === undefined ? 'udp' : String((ready['transports'] as string[])[0]);
  const report = existsSync(join(dir, 'report.json')) ? (JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Record<string, unknown>) : undefined;
  const start = (frames[0]?.t ?? 0) + fromS * 1000;
  const window = frames.filter((f) => f.t >= start - 250 && f.t <= start + seconds * 1000 + 250);
  if (window.length < 2) {
    process.stderr.write('render: the trace does not cover that time\n');
    return 2;
  }
  const scale = H / size;
  // Follow the player with the most others within 50 m: interest management shows best in a crowd.
  const first = window[0]!.players;
  let viewer = first[0]?.[0];
  let most = -1;
  for (const [id, x, z] of first) {
    const around = first.filter(([, x2, z2]) => Math.hypot(x2 - x, z2 - z) <= 50).length;
    if (around > most) {
      most = around;
      viewer = id;
    }
  }
  const canvas = new Canvas();
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'devlog.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>((r) => ffmpeg.on('exit', (code) => r(code ?? 1)));
  const total = Math.floor(seconds * FPS);
  let k = 0;
  const p = (report?.['downKbps'] as { noVoice?: { mean?: number }; withVoice?: { mean?: number } } | undefined) ?? {};
  const tick = (report?.['tickMs'] as { p99?: number } | undefined)?.p99;
  for (let n = 0; n < total; n++) {
    const t = start + (n * 1000) / FPS;
    while (k < window.length - 2 && window[k + 1]!.t <= t) k += 1;
    const a = window[k]!;
    const b = window[k + 1] ?? a;
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const later = new Map(b.players.map((q) => [q[0], q]));
    const players = a.players.map(([id, x, z, talking]) => {
      const q = later.get(id);
      return { id, x: q ? x + (q[1] - x) * f : x, z: q ? z + (q[2] - z) * f : z, talking: (f < 0.5 ? talking : (q?.[3] ?? talking)) === 1 };
    });

    canvas.clear(BG);
    const me = players.find((q) => q.id === viewer);
    if (me) {
      for (let cx = 0; cx < size / CELL; cx++) {
        for (let cz = 0; cz < size / CELL; cz++) {
          const dx = Math.max(cx * CELL - me.x, 0, me.x - (cx + 1) * CELL);
          const dz = Math.max(cz * CELL - me.z, 0, me.z - (cz + 1) * CELL);
          const d = Math.hypot(dx, dz);
          if (d <= 50) canvas.rect(cx * CELL * scale, cz * CELL * scale, CELL * scale, CELL * scale, d <= 15 ? NEAR : RING);
        }
      }
    }
    for (let g = 0; g <= size; g += CELL) {
      canvas.rect(g * scale, 0, 1, H, GRID);
      canvas.rect(0, g * scale, H, 1, GRID);
    }
    if (me) canvas.ring(me.x * scale, me.z * scale, 25 * scale, TALK, 0.35);
    const pulse = 0.5 + 0.5 * Math.sin((t / 1000) * Math.PI * 4);
    for (const q of players) {
      const x = q.x * scale;
      const y = q.z * scale;
      if (q.talking) {
        canvas.ring(x, y, 5 + 3 * pulse, TALK, 0.6);
        canvas.disc(x, y, 3, TALK);
      } else {
        canvas.disc(x, y, 2.6, IDLE);
      }
    }
    if (me) canvas.ring(me.x * scale, me.z * scale, 7, WHITE, 0.9, 1.5);

    const left = H + 36;
    canvas.text(left, 40, 'FLATCHAT · S0.07', TALK, 3);
    canvas.text(left, 78, 'SPIKE S-NET: ONE WORLD SERVER', TEXT, 2);
    canvas.text(left, 104, transport === 'rtc' ? 'WEBRTC DATA CHANNELS' : 'RAW UDP, OUR OWN ENCRYPTION', DIM, 2);
    const elapsed = Math.max(0, (t - (frames[0]?.t ?? 0)) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    canvas.text(left, 170, `T+ ${mm}:${ss}`, TEXT, 3);
    canvas.text(left, 214, `PLAYERS ${players.length}`, TEXT, 3);
    canvas.text(left, 254, `TALKING ${players.filter((q) => q.talking).length}`, TALK, 3);
    canvas.disc(left + 8, 330, 5, TALK);
    canvas.text(left + 24, 323, 'TALKING', DIM, 2);
    canvas.disc(left + 8, 358, 4, IDLE);
    canvas.text(left + 24, 351, 'LISTENING', DIM, 2);
    canvas.rect(left, 378, 16, 16, NEAR);
    canvas.text(left + 24, 379, 'NEAR CELLS: FULL AT 20 HZ', DIM, 2);
    canvas.rect(left, 406, 16, 16, RING);
    canvas.text(left + 24, 407, 'RING: FULL AT 5 HZ', DIM, 2);
    canvas.ring(left + 8, 442, 7, TALK, 0.6);
    canvas.text(left + 24, 435, 'VOICE RANGE 25 M', DIM, 2);
    canvas.text(left + 24, 463, 'THE REST: POSITIONS AT 1 HZ', DIM, 2);
    if (report) {
      canvas.text(left, 530, `TICK P99 ${tick !== undefined ? tick.toFixed(1) : '?'} MS AT 20 HZ`, TEXT, 2);
      canvas.text(left, 560, `STATE ${Math.round(p.noVoice?.mean ?? 0)} KBPS / CLIENT`, TEXT, 2);
      canvas.text(left, 590, `WITH VOICE ${Math.round(p.withVoice?.mean ?? 0)} KBPS`, TEXT, 2);
    }
    canvas.text(left, 680, '32 M CELLS · 256 M WORLD', DIM, 2);

    if (n === Math.floor(total / 2)) writeFileSync(join(dir, 'devlog.png'), png(canvas));
    if (!ffmpeg.stdin.write(canvas.px)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  }
  ffmpeg.stdin.end();
  const code = await done;
  process.stdout.write(`${JSON.stringify({ event: 'render', ok: code === 0, frames: total, mp4: join(dir, 'devlog.mp4'), png: join(dir, 'devlog.png') })}\n`);
  return code === 0 ? 0 : 1;
}

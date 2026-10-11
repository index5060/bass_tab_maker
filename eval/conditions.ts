/**
 * The ways a real recording differs from a score, as variations of the ground-truth tab.
 *
 * Each condition changes only how the audio is played, never which notes are in it — so the
 * same truth scores every one of them.
 */

export interface Condition {
  name: string;
  /** Silence before the first downbeat, as most real files have. */
  leadMs: number;
  /** Rewrite the score before rendering (e.g. tempo drift). */
  transform?: (tex: string) => string;
  /**
   * How much of the band leaks into the bass stem (amplitude, 0..1). Separation is never
   * perfect: kick drum and low guitar bleed into the bass stem, typically 20-30dB down.
   */
  bleed?: number;
}

/** Give every bar of the bass track its own tempo, wandering like a band without a click. */
export function withTempoDrift(tex: string, baseBpm: number, spreadBpm: number, seed = 7): string {
  let state = seed;
  const random = () => {
    // Deterministic, so every run hears the same performance.
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const lines = tex.split('\n');
  const start = lines.findIndex((l) => l.startsWith('\\staff{tabs}')) + 1;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('\\track'));
  let bpm = baseBpm;
  for (let i = start; i < end; i++) {
    if (!lines[i].trim().endsWith('|')) continue;
    // A slow random walk around the base tempo, the way a drummer drifts.
    bpm = Math.min(baseBpm + spreadBpm, Math.max(baseBpm - spreadBpm, bpm + (random() - 0.5) * spreadBpm));
    lines[i] = `\\tempo ${bpm.toFixed(1)} ${lines[i]}`;
  }
  return lines.join('\n');
}

/** The tempo written at the top of a score. */
export function scoreTempo(tex: string): number {
  return Number(/\\tempo\s+([\d.]+)/.exec(tex)?.[1] ?? 120);
}

/** Swap the bass sound (General MIDI program), keeping every note. */
export function withBassProgram(tex: string, program: number): string {
  return tex.replace('\\instrument 33', `\\instrument ${program}`);
}

export const CONDITIONS: Condition[] = [
  { name: '0초에 바로 시작', leadMs: 0 },
  { name: '앞에 무음 237ms', leadMs: 237 },
  { name: '템포 흔들림 ±3', leadMs: 237, transform: (tex) => withTempoDrift(tex, scoreTempo(tex), 3) },
  { name: '피크 베이스', leadMs: 237, transform: (tex) => withBassProgram(tex, 34) },
  { name: '프렛리스', leadMs: 237, transform: (tex) => withBassProgram(tex, 35) },
  { name: '슬랩', leadMs: 237, transform: (tex) => withBassProgram(tex, 36) },
  { name: '신스 베이스', leadMs: 237, transform: (tex) => withBassProgram(tex, 38) },
  { name: '분리 번짐 -30dB', leadMs: 237, bleed: 0.0316 },
  { name: '분리 번짐 -20dB', leadMs: 237, bleed: 0.1 },
];

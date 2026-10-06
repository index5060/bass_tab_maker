/**
 * A deck of interchangeable audio sources that all ride the same clock.
 *
 * Why a deck instead of a mixer
 * -----------------------------
 * Once stems exist there are three recorded sources for one song — the original, the
 * isolated bass, and the band without bass — and all three are the same length, sample for
 * sample, because two of them were cut out of the third.
 *
 * The tempting design is to play them together and cross-fade. Do not: two <audio> elements
 * drift apart by tens of milliseconds, and on a drum transient that reads as a flam. The fix
 * would be Web Audio buffer sources (sample-locked by construction) — but AudioBufferSourceNode
 * has no pitch preservation, so slowing down would drop the pitch and fight the whole point of
 * the speed control.
 *
 * So: every source runs, every source follows alphaTab, and exactly one is audible. Drift
 * between stems becomes unobservable because you never hear two at once, and switching costs
 * nothing but a gain change — no re-seek, no decode gap. That is also what was asked for
 * originally: click to pick a source, Songsterr-style.
 *
 * Blending stems continuously is the one thing this design gives up. That needs buffer
 * sources plus a time-stretch worklet per stem, and it is a separate build.
 */

import { OriginalTrack, type DriftReport } from './originalTrack';

export type DeckSourceId = 'original' | 'bass' | 'minusBass';

export const DECK_SOURCE_LABELS: Record<DeckSourceId, string> = {
  original: '원본',
  bass: '베이스만',
  minusBass: '반주만',
};

export interface DeckDrift {
  /** Drift of the currently audible source against alphaTab. */
  active: DriftReport;
  /** Worst drift across all loaded sources, for diagnostics. */
  worstMs: number;
}

export class AudioDeck {
  private _tracks = new Map<DeckSourceId, OriginalTrack>();
  private _active: DeckSourceId = 'original';
  private _gain = 1;
  private _speed = 1;

  get activeId(): DeckSourceId {
    return this._active;
  }

  get loadedIds(): DeckSourceId[] {
    return [...this._tracks.keys()];
  }

  has(id: DeckSourceId): boolean {
    return this._tracks.has(id);
  }

  get hasAny(): boolean {
    return this._tracks.size > 0;
  }

  /** The audible track, or null when nothing is loaded for the active id. */
  private get activeTrack(): OriginalTrack | null {
    return this._tracks.get(this._active) ?? null;
  }

  get positionMs(): number {
    return this.activeTrack?.positionMs ?? 0;
  }

  get durationMs(): number {
    return this.activeTrack?.durationMs ?? 0;
  }

  get isPaused(): boolean {
    const t = this.activeTrack;
    return t ? t.audio.paused : true;
  }

  async load(id: DeckSourceId, blob: Blob): Promise<void> {
    let track = this._tracks.get(id);
    if (!track) {
      track = new OriginalTrack();
      this._tracks.set(id, track);
    }
    await track.load(blob);
    track.setSpeed(this._speed);
    this.applyGains();
  }

  unload(id: DeckSourceId): void {
    const track = this._tracks.get(id);
    if (!track) return;
    track.release();
    this._tracks.delete(id);
    if (this._active === id) this._active = 'original';
    this.applyGains();
  }

  unloadStems(): void {
    this.unload('bass');
    this.unload('minusBass');
  }

  releaseAll(): void {
    for (const t of this._tracks.values()) t.release();
    this._tracks.clear();
  }

  /**
   * Switch which source is audible. Instant: the others keep running silently at the same
   * position, so there is nothing to re-seek and nothing to re-buffer.
   */
  setActive(id: DeckSourceId): void {
    this._active = id;
    this.applyGains();
  }

  /** Master gain for the recorded side as a whole (0 mutes it so only the synth is heard). */
  setGain(v: number): void {
    this._gain = Math.min(1, Math.max(0, v));
    this.applyGains();
  }

  setSpeed(rate: number): void {
    this._speed = rate;
    for (const t of this._tracks.values()) t.setSpeed(rate);
  }

  private applyGains(): void {
    for (const [id, track] of this._tracks) {
      track.setVolume(id === this._active ? this._gain : 0);
    }
  }

  async play(atMs?: number): Promise<void> {
    await Promise.all([...this._tracks.values()].map((t) => t.play(atMs)));
  }

  pause(): void {
    for (const t of this._tracks.values()) t.pause();
  }

  seek(ms: number): void {
    for (const t of this._tracks.values()) t.seek(ms);
  }

  /**
   * Pull every source towards `targetMs`. They are corrected independently — that is fine
   * precisely because only one of them is audible.
   */
  syncTo(targetMs: number, opts: { isSeek?: boolean } = {}): DeckDrift {
    let active: DriftReport = { errorMs: 0, corrected: 'none' };
    let worstMs = 0;
    for (const [id, track] of this._tracks) {
      const report = track.syncTo(targetMs, opts);
      if (Math.abs(report.errorMs) > Math.abs(worstMs)) worstMs = report.errorMs;
      if (id === this._active) active = report;
    }
    return { active, worstMs };
  }
}

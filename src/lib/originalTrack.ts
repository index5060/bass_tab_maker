/**
 * The original recording, running as a *follower* of alphaTab's clock.
 *
 * Architecture note (this is the load-bearing decision of the whole app):
 *
 * alphaTab stays in PlayerMode.EnabledSynthesizer permanently and owns the transport —
 * play/pause, the cursor, loop range, playbackSpeed, metronome, count-in. We never switch
 * PlayerMode at runtime, because alphaTab tears down and rebuilds the whole player when that
 * setting changes (_setupOrDestroyPlayer), which would mean re-loading the MIDI and the
 * soundfont on every click of the source toggle. Songsterr's toggle is instant; a 1-2 second
 * rebuild is not.
 *
 * So instead the original audio rides along on its own <audio> element, continuously chasing
 * the position the sync map says it should be at, and the "원본 / 신디" toggle is nothing but
 * two gain changes. That makes switching instant and gapless, and it means the crossfade
 * (both at once, mixed) is already implemented — it is the same two gains with a different UI.
 *
 * The cost is drift: two independent clocks will separate over time. That is what
 * `syncTo()` handles, with a hard seek for big errors and an inaudible rate nudge for
 * small ones.
 *
 * Time-stretching: `preservesPitch` defaults to true on modern browsers, so simply setting
 * playbackRate gives pitch-preserved slowdown for free. It gets smeary below ~0.6x. When that
 * stops being good enough, replace the innards of this class with an AudioWorklet running
 * signalsmith-stretch — nothing outside this file needs to know.
 */

export interface DriftReport {
  /** Positive = the recording is running ahead of the tab. */
  errorMs: number;
  corrected: 'none' | 'nudge' | 'seek';
}

export interface OriginalTrackOptions {
  /** Above this error we give up on nudging and just jump. */
  hardSeekMs?: number;
  /** Below this error we stop correcting entirely (dead band, prevents hunting). */
  deadBandMs?: number;
  /** Maximum rate deviation used for correction. 0.005 = 0.5%, well under audible pitch change. */
  maxNudge?: number;
}

const DEFAULTS: Required<OriginalTrackOptions> = {
  hardSeekMs: 120,
  deadBandMs: 12,
  maxNudge: 0.005,
};

export class OriginalTrack {
  readonly audio: HTMLAudioElement;
  private _objectUrl: string | null = null;
  private _baseRate = 1;
  private _opts: Required<OriginalTrackOptions>;
  private _lastReport: DriftReport = { errorMs: 0, corrected: 'none' };

  constructor(opts: OriginalTrackOptions = {}) {
    this._opts = { ...DEFAULTS, ...opts };
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    // Keep pitch when slowed down. Default is already true in current browsers, but Safari
    // used a prefix for a long time and being explicit costs nothing.
    setPreservesPitch(this.audio, true);
  }

  get hasTrack(): boolean {
    return this._objectUrl !== null;
  }

  get durationMs(): number {
    const d = this.audio.duration;
    return Number.isFinite(d) ? d * 1000 : 0;
  }

  get positionMs(): number {
    return this.audio.currentTime * 1000;
  }

  get lastDrift(): DriftReport {
    return this._lastReport;
  }

  async load(blob: Blob): Promise<void> {
    this.release();
    this._objectUrl = URL.createObjectURL(blob);
    this.audio.src = this._objectUrl;
    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('오디오 파일을 디코딩하지 못했습니다.'));
      };
      const cleanup = () => {
        this.audio.removeEventListener('loadedmetadata', ok);
        this.audio.removeEventListener('error', fail);
      };
      this.audio.addEventListener('loadedmetadata', ok);
      this.audio.addEventListener('error', fail);
      this.audio.load();
    });
  }

  release(): void {
    this.audio.pause();
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    this.audio.removeAttribute('src');
  }

  setVolume(v: number): void {
    this.audio.volume = Math.min(1, Math.max(0, v));
    // volume 0 still decodes; that is deliberate. Keeping it running is what makes the
    // toggle instant instead of having to re-seek and re-buffer on every switch.
  }

  setSpeed(rate: number): void {
    this._baseRate = rate;
    this.audio.playbackRate = rate;
  }

  async play(atMs?: number): Promise<void> {
    if (!this.hasTrack) return;
    if (atMs !== undefined) this.audio.currentTime = clampSeconds(atMs / 1000, this.audio.duration);
    try {
      await this.audio.play();
    } catch {
      // Autoplay policy — the user gesture that started alphaTab should have unlocked this,
      // but if not, the next play() from a click will succeed.
    }
  }

  pause(): void {
    this.audio.pause();
  }

  seek(ms: number): void {
    if (!this.hasTrack) return;
    this.audio.currentTime = clampSeconds(ms / 1000, this.audio.duration);
    this.audio.playbackRate = this._baseRate;
  }

  /**
   * Pull the recording back towards where the tab says it should be.
   * Call this on every alphaTab position update.
   */
  syncTo(targetMs: number, opts: { isSeek?: boolean } = {}): DriftReport {
    if (!this.hasTrack) {
      this._lastReport = { errorMs: 0, corrected: 'none' };
      return this._lastReport;
    }

    const errorMs = this.positionMs - targetMs;
    const abs = Math.abs(errorMs);

    if (opts.isSeek || abs > this._opts.hardSeekMs) {
      this.seek(targetMs);
      this._lastReport = { errorMs, corrected: 'seek' };
      return this._lastReport;
    }

    if (abs <= this._opts.deadBandMs) {
      if (this.audio.playbackRate !== this._baseRate) this.audio.playbackRate = this._baseRate;
      this._lastReport = { errorMs, corrected: 'none' };
      return this._lastReport;
    }

    // Proportional correction, capped so the pitch shift stays inaudible.
    // errorMs > 0 means we are ahead, so slow down slightly.
    const correction = Math.max(
      -this._opts.maxNudge,
      Math.min(this._opts.maxNudge, -errorMs / 4000),
    );
    this.audio.playbackRate = this._baseRate * (1 + correction);
    this._lastReport = { errorMs, corrected: 'nudge' };
    return this._lastReport;
  }
}

function clampSeconds(s: number, duration: number): number {
  const max = Number.isFinite(duration) ? Math.max(0, duration - 0.05) : s;
  return Math.min(max, Math.max(0, s));
}

function setPreservesPitch(el: HTMLAudioElement, value: boolean): void {
  const anyEl = el as HTMLAudioElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  if ('preservesPitch' in anyEl) anyEl.preservesPitch = value;
  if ('mozPreservesPitch' in anyEl) anyEl.mozPreservesPitch = value;
  if ('webkitPreservesPitch' in anyEl) anyEl.webkitPreservesPitch = value;
}

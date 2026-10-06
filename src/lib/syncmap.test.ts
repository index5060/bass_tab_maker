import { describe, it, expect } from 'vitest';
import {
  normalizeAnchors,
  isUsable,
  tickToAudioMs,
  audioMsToTick,
  tempoRatioAt,
  driftIfLinear,
} from './syncmap';
import type { SyncAnchor } from './types';

const a = (synthTick: number, audioMs: number): SyncAnchor => ({ synthTick, audioMs });

describe('normalizeAnchors', () => {
  it('sorts by tick', () => {
    const n = normalizeAnchors([a(1000, 2000), a(0, 500)]);
    expect(n.map((x) => x.synthTick)).toEqual([0, 1000]);
  });

  it('lets a re-tap at the same tick win', () => {
    const n = normalizeAnchors([a(0, 500), a(0, 800)]);
    expect(n).toHaveLength(1);
    expect(n[0].audioMs).toBe(800);
  });

  it('drops anchors that would make audio run backwards', () => {
    const n = normalizeAnchors([a(0, 1000), a(960, 500), a(1920, 3000)]);
    expect(n.map((x) => x.synthTick)).toEqual([0, 1920]);
  });

  it('drops non-finite entries', () => {
    const n = normalizeAnchors([a(0, 0), a(Number.NaN, 100), a(960, 500)]);
    expect(n).toHaveLength(2);
  });
});

describe('isUsable', () => {
  it('needs two anchors', () => {
    expect(isUsable(normalizeAnchors([a(0, 0)]))).toBe(false);
    expect(isUsable(normalizeAnchors([a(0, 0), a(960, 500)]))).toBe(true);
  });
});

describe('tickToAudioMs', () => {
  const two = normalizeAnchors([a(0, 1000), a(3840, 3000)]);

  it('returns null without enough anchors', () => {
    expect(tickToAudioMs(normalizeAnchors([a(0, 0)]), 100)).toBeNull();
  });

  it('hits the anchors exactly', () => {
    expect(tickToAudioMs(two, 0)).toBe(1000);
    expect(tickToAudioMs(two, 3840)).toBe(3000);
  });

  it('interpolates linearly between two anchors', () => {
    expect(tickToAudioMs(two, 1920)).toBe(2000);
  });

  it('extrapolates before the first and after the last anchor', () => {
    expect(tickToAudioMs(two, -3840)!).toBeCloseTo(-1000, 6);
    expect(tickToAudioMs(two, 7680)!).toBeCloseTo(5000, 6);
  });

  it('is piecewise: a middle anchor bends the map', () => {
    // Second half runs at half the speed of the first half.
    const three = normalizeAnchors([a(0, 0), a(1000, 1000), a(2000, 3000)]);
    expect(tickToAudioMs(three, 500)).toBe(500);
    expect(tickToAudioMs(three, 1500)).toBe(2000);
  });

  it('is monotonic across many anchors', () => {
    const many = normalizeAnchors([a(0, 0), a(500, 400), a(1500, 1800), a(2500, 2600), a(4000, 4500)]);
    let prev = -Infinity;
    for (let t = -200; t <= 4500; t += 37) {
      const v = tickToAudioMs(many, t)!;
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('audioMsToTick', () => {
  it('round-trips with tickToAudioMs', () => {
    const anchors = normalizeAnchors([a(0, 500), a(1920, 2500), a(5760, 6000)]);
    for (const tick of [0, 480, 1920, 3000, 5760, 7000]) {
      const ms = tickToAudioMs(anchors, tick)!;
      expect(audioMsToTick(anchors, ms)!).toBeCloseTo(tick, 6);
    }
  });

  it('returns null without enough anchors', () => {
    expect(audioMsToTick(normalizeAnchors([]), 1000)).toBeNull();
  });
});

describe('tempoRatioAt', () => {
  it('reports 1.0 when the recording matches the written tempo', () => {
    // 120 BPM, 960 ticks/quarter -> 0.5208333 ms per tick. One bar of 4/4 = 3840 ticks = 2000ms.
    const anchors = normalizeAnchors([a(0, 0), a(3840, 2000)]);
    expect(tempoRatioAt(anchors, 1000, 960, 120)!).toBeCloseTo(1, 6);
  });

  it('reports >1 when the recording is faster than the score', () => {
    const anchors = normalizeAnchors([a(0, 0), a(3840, 1000)]);
    expect(tempoRatioAt(anchors, 1000, 960, 120)!).toBeCloseTo(2, 6);
  });
});

describe('driftIfLinear', () => {
  it('is null with fewer than three anchors', () => {
    expect(driftIfLinear(normalizeAnchors([a(0, 0), a(100, 100)]), 50)).toBeNull();
  });

  it('is zero when the middle anchor sits on the straight line', () => {
    const anchors = normalizeAnchors([a(0, 0), a(1000, 1000), a(2000, 2000)]);
    expect(driftIfLinear(anchors, 750)!).toBeCloseTo(0, 6);
  });

  it('measures how far a two-anchor approximation would be off', () => {
    // True map bends at tick 1000; the straight line from 0 to 2000 predicts 1500 there.
    const anchors = normalizeAnchors([a(0, 0), a(1000, 1000), a(2000, 3000)]);
    expect(driftIfLinear(anchors, 1000)!).toBeCloseTo(500, 6);
  });
});

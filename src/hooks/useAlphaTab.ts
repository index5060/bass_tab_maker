import { useCallback, useEffect, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';

export interface AlphaTabPosition {
  currentTick: number;
  endTick: number;
  currentTimeMs: number;
  endTimeMs: number;
  isSeek: boolean;
}

export interface AlphaTabState {
  ready: boolean;
  soundFontReady: boolean;
  playing: boolean;
  position: AlphaTabPosition;
  scoreTitle: string;
  trackNames: string[];
  /** Bar index the cursor is currently on, from playedBeatChanged. */
  currentBarIndex: number;
  ticksPerQuarter: number;
  scoreBpm: number;
  error: string | null;
}

const INITIAL: AlphaTabState = {
  ready: false,
  soundFontReady: false,
  playing: false,
  position: { currentTick: 0, endTick: 0, currentTimeMs: 0, endTimeMs: 0, isSeek: false },
  scoreTitle: '',
  trackNames: [],
  currentBarIndex: 0,
  ticksPerQuarter: 960,
  scoreBpm: 120,
  error: null,
};

export interface UseAlphaTabOptions {
  /** Called on every position update. Kept in a ref so it never re-creates the player. */
  onPosition?: (pos: AlphaTabPosition) => void;
  tabOnly?: boolean;
}

export function useAlphaTab(options: UseAlphaTabOptions = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const [state, setState] = useState<AlphaTabState>(INITIAL);

  // Callbacks live in a ref so that changing them never tears down the player.
  const onPositionRef = useRef(options.onPosition);
  onPositionRef.current = options.onPosition;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const api = new alphaTab.AlphaTabApi(el, {
      core: {
        // The vite plugin copies Bravura into public/font.
        fontDirectory: '/font/',
      },
      display: {
        // Bass practice: tab only by default. Flip to ScoreTab if you want the stave too.
        staveProfile: options.tabOnly === false
          ? alphaTab.StaveProfile.ScoreTab
          : alphaTab.StaveProfile.Tab,
        layoutMode: alphaTab.LayoutMode.Page,
        scale: 1.1,
      },
      player: {
        // Never changed at runtime — see the comment block in lib/originalTrack.ts for why.
        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
        soundFont: '/soundfont/sonivox.sf3',
        scrollElement: viewportRef.current ?? el,
        scrollMode: alphaTab.ScrollMode.Continuous,
        scrollOffsetY: -40,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
      },
    });
    apiRef.current = api;

    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      api.scoreLoaded.on((score) => {
        const bpm = score.masterBars[0]?.tempoAutomations?.[0]?.value ?? score.tempo ?? 120;
        setState((s) => ({
          ...s,
          scoreTitle: score.title || 'Untitled',
          trackNames: score.tracks.map((t, i) => t.name || `Track ${i + 1}`),
          ticksPerQuarter: 960, // alphaTab's MIDI resolution
          scoreBpm: bpm,
          error: null,
        }));
      }),
    );

    unsubscribers.push(
      api.playerReady.on(() => {
        setState((s) => ({ ...s, ready: true }));
      }),
    );

    unsubscribers.push(
      api.soundFontLoaded.on(() => {
        setState((s) => ({ ...s, soundFontReady: true }));
      }),
    );

    unsubscribers.push(
      api.playerStateChanged.on((e) => {
        setState((s) => ({ ...s, playing: e.state === alphaTab.synth.PlayerState.Playing }));
      }),
    );

    unsubscribers.push(
      api.playerPositionChanged.on((e) => {
        const pos: AlphaTabPosition = {
          currentTick: e.currentTick,
          endTick: e.endTick,
          currentTimeMs: e.currentTime,
          endTimeMs: e.endTime,
          isSeek: e.isSeek,
        };
        onPositionRef.current?.(pos);
        setState((s) => ({ ...s, position: pos }));
      }),
    );

    unsubscribers.push(
      api.playedBeatChanged.on((beat) => {
        const barIndex = beat.voice?.bar?.index ?? 0;
        setState((s) => (s.currentBarIndex === barIndex ? s : { ...s, currentBarIndex: barIndex }));
      }),
    );

    unsubscribers.push(
      api.error.on((e) => {
        setState((s) => ({ ...s, error: explainError(e?.message ?? String(e)) }));
      }),
    );

    return () => {
      for (const u of unsubscribers) u();
      api.destroy();
      apiRef.current = null;
      setState(INITIAL);
    };
    // Intentionally mount-only. Runtime changes go through the imperative helpers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAlphaTex = useCallback((tex: string) => {
    apiRef.current?.tex(tex);
  }, []);

  const loadFile = useCallback((data: ArrayBuffer, trackIndexes?: number[]) => {
    apiRef.current?.load(new Uint8Array(data), trackIndexes);
  }, []);

  const setTrack = useCallback((index: number) => {
    const api = apiRef.current;
    if (!api?.score) return;
    const track = api.score.tracks[index];
    if (track) api.renderTracks([track]);
  }, []);

  const setStaveProfile = useCallback((tabOnly: boolean) => {
    const api = apiRef.current;
    if (!api) return;
    api.settings.display.staveProfile = tabOnly
      ? alphaTab.StaveProfile.Tab
      : alphaTab.StaveProfile.ScoreTab;
    api.updateSettings();
    api.render();
  }, []);

  return { containerRef, viewportRef, apiRef, state, loadAlphaTex, loadFile, setTrack, setStaveProfile };
}

/**
 * alphaTab's own error text for a missing/misserved asset is unhelpful ("Soundfont is not a
 * valid Soundfont2 file") because what actually came back was the SPA fallback HTML. Say the
 * useful thing instead.
 */
function explainError(message: string): string {
  if (/Soundfont is not a valid/i.test(message) || /Font not available/i.test(message)) {
    return (
      'alphaTab 에셋(Bravura 폰트 / 사운드폰트)을 불러오지 못했습니다. ' +
      'public/font, public/soundfont가 비어 있을 수 있습니다 — dev 서버를 껐다가 ' +
      '"npm run dev"로 다시 시작하세요. (원문: ' + message + ')'
    );
  }
  return message;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAlphaTab, type AlphaTabPosition } from './hooks/useAlphaTab';
import { AudioDeck } from './lib/audioDeck';
import {
  detectCapability,
  diagnoseIsolation,
  importBassStem,
  loadDemucsSeparator,
  type IsolationDiagnosis,
  type SeparationCapability,
  type Separator,
} from './lib/separator';
import { normalizeAnchors, isUsable, tickToAudioMs } from './lib/syncmap';
import { BLANK_ALPHATEX, DEMO_ALPHATEX, DEMO_DOC_ID, blankAlphaTex, isBlankScore } from './lib/demoScore';
import {
  transcribeBassStem,
  notesToAutoTab,
  type AutoTabProgress,
  type AutoTabResult,
  type AutoTabSummary,
} from './lib/autoTab';
import {
  newPracticeDoc,
  type PracticeDoc,
  type PlaybackSource,
  type StemSet,
  type SyncAnchor,
} from './lib/types';
import type { SeparationProgress } from './lib/stems';
import {
  createSongSaver,
  listSongs,
  getSong,
  saveSong,
  deleteSong,
  purgeEmptyDemos,
  rescueDemoRecord,
  requestPersistentStorage,
  estimateStorage,
  type SongMeta,
  type StorageStatus,
} from './lib/storage';
import { encodeSongFile, decodeSongFile, songFileName } from './lib/songFile';
import {
  probeSidecar,
  transcribeViaSidecar,
  downloadFromYouTube,
  fileSafe,
  SidecarSeparator,
  DEFAULT_SIDECAR_SETTINGS,
  type SidecarInfo,
  type SidecarSettings,
} from './lib/sidecar';
import { Transport } from './components/Transport';
import { SourceToggle } from './components/SourceToggle';
import { SyncPanel } from './components/SyncPanel';
import { StemPanel } from './components/StemPanel';
import { YouTubePanel, type PipelineState, type PipelineStep } from './components/YouTubePanel';
import './styles.css';

const IDLE_PROGRESS: SeparationProgress = { phase: 'idle', progress: 0 };

export default function App() {
  const [doc, setDoc] = useState<PracticeDoc>(() =>
    newPracticeDoc({
      // Fixed id: a random one per load is what used to breed duplicate starter songs.
      id: DEMO_DOC_ID,
      title: 'Warm-up: Position Shifts',
      scoreKind: 'alphatex',
      scoreData: DEMO_ALPHATEX,
    }),
  );
  // Metadata only — the full blobs are fetched when a song is opened.
  const [library, setLibrary] = useState<SongMeta[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [source, setSource] = useState<PlaybackSource>('synth');
  const [looping, setLooping] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [tabOnly, setTabOnly] = useState(true);
  const [anchorMode, setAnchorMode] = useState(false);
  const [audioPos, setAudioPos] = useState({ ms: 0, durationMs: 0, playing: false });
  const [drift, setDrift] = useState<{ ms: number; action: 'none' | 'nudge' | 'seek' }>({
    ms: 0,
    action: 'none',
  });

  const [sepBusy, setSepBusy] = useState(false);
  const [sepProgress, setSepProgress] = useState<SeparationProgress>(IDLE_PROGRESS);
  const [sepError, setSepError] = useState<string | null>(null);
  const [tabBusy, setTabBusy] = useState(false);
  const [tabProgress, setTabProgress] = useState<AutoTabProgress | null>(null);
  const [tabResult, setTabResult] = useState<AutoTabSummary | null>(null);
  /** Empty = estimate the tempo; a number pins the grid to it (phase is still fitted). */
  const [tabBpm, setTabBpm] = useState('');
  /** Full last transcription result, kept for the diagnostic export. */
  const tabDiagRef = useRef<AutoTabResult | null>(null);
  /** The link -> audio -> stem -> tab run, while it is going and after it ends. */
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [autoPipeline, setAutoPipeline] = useState(true);

  const deckRef = useRef<AudioDeck | null>(null);
  if (!deckRef.current) deckRef.current = new AudioDeck();
  const separatorRef = useRef<Separator | null>(null);

  const anchorsRef = useRef<SyncAnchor[]>(doc.syncAnchors);
  anchorsRef.current = doc.syncAnchors;
  // The song on screen right now, for work that finishes minutes after it started.
  const docRef = useRef(doc);
  docRef.current = doc;
  const anchorModeRef = useRef(anchorMode);
  anchorModeRef.current = anchorMode;

  const saver = useMemo(
    () =>
      createSongSaver(
        600,
        () => {
          // A song usually reaches the database through this autosave rather than through
          // "악보 열기", so the list has to refresh here or it never shows up.
          setSaveError(null);
          listSongs().then(setLibrary).catch(() => undefined);
          estimateStorage().then((e) => setStorage((s) => (s ? { ...s, ...e } : s)));
        },
        (err) => {
          // Previously this rejection vanished as an unhandled promise and the song simply
          // never appeared, with nothing on screen to say why.
          setSaveError(`저장 실패: ${err.message}`);
        },
      ),
    [],
  );
  const [capability, setCapability] = useState<SeparationCapability | null>(null);
  const [isolationDiag, setIsolationDiag] = useState<IsolationDiagnosis | null>(null);
  const [sidecar, setSidecar] = useState<SidecarInfo | null>(null);
  const [sidecarSettings, setSidecarSettings] = useState<SidecarSettings>(DEFAULT_SIDECAR_SETTINGS);
  const [useSidecar, setUseSidecar] = useState(true);

  // Probing is cheap, never throws, and a missing sidecar is the normal case.
  useEffect(() => {
    let cancelled = false;
    probeSidecar()
      .then((info) => !cancelled && setSidecar(info))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The usual order is "open the app, notice the sidecar is needed, start it" — without a way
  // to look again, that meant reloading the page.
  const recheckSidecar = useCallback(() => {
    probeSidecar()
      .then(setSidecar)
      .catch(() => undefined);
  }, []);

  // WebGPU probing is async, so capability cannot be a useMemo.
  useEffect(() => {
    let cancelled = false;
    detectCapability()
      .then(async (cap) => {
        if (cancelled) return;
        setCapability(cap);
        // The header round trip only earns its keep when we are stuck on the slow path.
        if (cap.mode === 'wasm-single') {
          const diag = await diagnoseIsolation().catch(() => null);
          if (!cancelled) setIsolationDiag(diag);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePosition = useCallback((pos: AlphaTabPosition) => {
    const deck = deckRef.current!;
    if (!deck.hasAny || anchorModeRef.current) return;
    const anchors = normalizeAnchors(anchorsRef.current);
    // No anchors yet: fall back to alphaTab's own musical time, 1:1. Both clocks measure
    // musical position rather than wall clock, so this stays correct at any playback speed,
    // and it is right on the nose whenever the recording starts at bar 1. Anchors then
    // refine it instead of being a precondition for hearing anything.
    const target = isUsable(anchors)
      ? tickToAudioMs(anchors, pos.currentTick)
      : pos.currentTimeMs;
    if (target === null) return;
    const report = deck.syncTo(target, { isSeek: pos.isSeek });
    setDrift({ ms: report.active.errorMs, action: report.active.corrected });
  }, []);

  const {
    containerRef,
    viewportRef,
    apiRef,
    state,
    loadAlphaTex,
    loadFile,
    setTrack,
    setStaveProfile,
    exportGuitarPro,
  } = useAlphaTab({ onPosition: handlePosition, tabOnly });

  /* ---------------------------------------------------------------- score */

  useEffect(() => {
    if (!state.ready && !apiRef.current) return;
    if (doc.scoreKind === 'alphatex') loadAlphaTex(doc.scoreData as string);
    else loadFile(doc.scoreData as ArrayBuffer, [doc.trackIndex]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.scoreKind, doc.scoreData]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Tidy up the two shapes of starter-song mess older versions could leave behind:
      // duplicates from when it took a random id per load, and a real recording filed under
      // the starter's fixed id. The latter is re-keyed into a proper song, never deleted.
      await purgeEmptyDemos(DEMO_ALPHATEX, DEMO_DOC_ID).catch(() => 0);
      const rescued = await rescueDemoRecord(DEMO_DOC_ID).catch(() => null);
      if (rescued) setSaveError(`예제 곡에 붙어 있던 작업을 "${rescued.title}"으로 분리했습니다.`);
      const songs = await listSongs().catch(() => [] as SongMeta[]);
      if (cancelled) return;
      setLibrary(songs);

      // Ask the browser not to evict us. Losing a separated song means redoing a 172MB
      // download and several minutes of inference, so it is worth asking on every start.
      requestPersistentStorage()
        .then((s) => !cancelled && setStorage(s))
        .catch(() => undefined);

      // Come back to whatever was last worked on rather than always to the starter song.
      const newest = songs[0];
      if (newest) {
        const full = await getSong(newest.id).catch(() => undefined);
        if (cancelled || !full) return;
        setDoc(full);
        setSpeed(full.lastSpeed);
        setSource(full.lastSource);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --------------------------------------------------------- audio + stems */

  useEffect(() => {
    const deck = deckRef.current!;
    if (!doc.audioBlob) {
      deck.releaseAll();
      setAudioPos({ ms: 0, durationMs: 0, playing: false });
      return;
    }
    let cancelled = false;
    deck
      .load('original', doc.audioBlob)
      .then(() => {
        if (cancelled) return;
        deck.setSpeed(speed);
        setAudioPos((p) => ({ ...p, durationMs: deck.durationMs }));

        // Playback stops at the end of the score, so a blank 8-bar staff cut a four-minute
        // recording off after sixteen seconds. Now that the duration is known, grow the
        // blank staff to cover it. Only ever touches a staff that is still empty.
        setDoc((d) => {
          if (!isBlankScore(d.scoreData)) return d;
          const bpm = 120;
          const bars = Math.ceil(deck.durationMs / 1000 / ((60 / bpm) * 4));
          const grown = blankAlphaTex(Math.max(8, bars), bpm, d.title);
          return grown === d.scoreData ? d : { ...d, scoreData: grown, updatedAt: Date.now() };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.audioBlob, sidecar, useSidecar, sidecarSettings]);

  useEffect(() => {
    const deck = deckRef.current!;
    const stems = doc.stems;
    if (!stems) {
      deck.unloadStems();
      // Fall back to the original if a stem source was selected when the stems went away.
      setSource((s) => (s === 'bass' || s === 'minusBass' ? 'original' : s));
      return;
    }
    let cancelled = false;
    Promise.all([deck.load('bass', stems.bass), deck.load('minusBass', stems.minusBass)])
      .then(() => {
        if (!cancelled) deck.setSpeed(speed);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.stems]);

  /* ------------------------------------------------------------ gains etc */

  const hasAudio = !!doc.audioBlob;
  const hasStems = !!doc.stems;
  // Playing a recording needs the recording, nothing else. Anchors only sharpen alignment,
  // so they are not part of this condition (SyncPanel works out anchor state on its own).
  const deckUsable = hasAudio;

  /**
   * Which source can actually be heard right now.
   *
   * A saved song restores `lastSource`, and that value can easily name something this song
   * does not have — "bass" on a song whose stems were deleted, "original" on one whose audio
   * never loaded. Handing that to the deck used to produce total silence: no deck track
   * matched, so every deck gain went to zero, and the synth was muted at the same time
   * because the app believed a recording was playing. Falling back to the synth keeps sound
   * coming out no matter what is stored.
   */
  const isSourceAvailable = useCallback(
    (s: PlaybackSource): boolean => {
      if (s === 'synth') return true;
      if (!hasAudio) return false;
      if (s === 'bass' || s === 'minusBass') return hasStems;
      return true;
    },
    [hasAudio, hasStems],
  );
  const effectiveSource: PlaybackSource = isSourceAvailable(source) ? source : 'synth';

  useEffect(() => {
    const api = apiRef.current;
    const deck = deckRef.current!;
    const onSynth = effectiveSource === 'synth';
    if (api) api.masterVolume = onSynth ? 1 : 0;
    if (!onSynth) deck.setActive(effectiveSource as 'original' | 'bass' | 'minusBass');
    deck.setGain(onSynth ? 0 : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSource, state.ready]);

  useEffect(() => {
    const api = apiRef.current;
    if (api) api.playbackSpeed = speed;
    deckRef.current!.setSpeed(speed);
  }, [speed, apiRef]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.isLooping = looping;
    api.metronomeVolume = metronome ? 1 : 0;
    api.countInVolume = countIn ? 1 : 0;
  }, [looping, metronome, countIn, state.ready, apiRef]);

  useEffect(() => {
    setStaveProfile(tabOnly);
  }, [tabOnly, setStaveProfile]);

  /* ------------------------------------------------ follow alphaTab state */

  useEffect(() => {
    const deck = deckRef.current!;
    if (anchorMode || !deck.hasAny) return;
    if (state.playing) {
      const anchors = normalizeAnchors(anchorsRef.current);
      const target = isUsable(anchors) ? tickToAudioMs(anchors, state.position.currentTick) : null;
      void deck.play(target ?? undefined);
    } else {
      deck.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.playing, anchorMode]);

  /* ------------------------------------------------------ anchor mode loop */

  useEffect(() => {
    if (!anchorMode) return;
    const deck = deckRef.current!;
    apiRef.current?.pause();
    deck.setActive('original');
    deck.setGain(1);
    let raf = 0;
    const tick = () => {
      setAudioPos({ ms: deck.positionMs, durationMs: deck.durationMs, playing: !deck.isPaused });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      deck.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorMode]);

  /* ---------------------------------------------------------- persistence */

  useEffect(() => {
    // The starter exercise is a template, not a song. It is never written to the library —
    // anything you attach to it forks a real song first (see attachToSong).
    if (doc.id === DEMO_DOC_ID) return;
    saver.queue({ ...doc, lastSpeed: speed, lastSource: source });
  }, [doc, speed, source, saver]);

  /* ------------------------------------------------------------- actions */

  const patchDoc = useCallback((patch: Partial<PracticeDoc>) => {
    setDoc((d) => ({ ...d, ...patch, updatedAt: Date.now() }));
  }, []);

  /**
   * Attach something substantial (a recording) to the current song.
   *
   * While the starter template is open this forks a real song instead of editing the
   * template, which is what makes "load audio -> a new song appears" true. Before this, your
   * recording and its stems were filed under the starter's fixed id and showed up in the
   * library as "Warm-up: Position Shifts" — saved correctly, but under a name that told you
   * nothing, so it read as though nothing had been created at all.
   */
  const attachToSong = useCallback((patch: Partial<PracticeDoc>, forkTitle?: string) => {
    setDoc((d) => {
      const now = Date.now();
      const onTemplate = d.id === DEMO_DOC_ID;
      // "새 곡" is a real song already, but until something is attached it is still a blank
      // named "새 곡" — taking the filename there too is the whole point of the rename.
      const stillUnnamed = !d.audioBlob && isBlankScore(d.scoreData);

      if (onTemplate) {
        return {
          ...d,
          ...patch,
          id: crypto.randomUUID(),
          title: forkTitle || d.title,
          createdAt: now,
          updatedAt: now,
        };
      }
      return {
        ...d,
        ...patch,
        ...(stillUnnamed && forkTitle ? { title: forkTitle } : {}),
        updatedAt: now,
      };
    });
  }, []);

  const onPlayPause = useCallback(() => apiRef.current?.playPause(), [apiRef]);

  const onStop = useCallback(() => {
    apiRef.current?.stop();
    const deck = deckRef.current!;
    deck.pause();
    const anchors = normalizeAnchors(anchorsRef.current);
    if (isUsable(anchors)) {
      const target = tickToAudioMs(anchors, 0);
      if (target !== null) deck.seek(target);
    }
  }, [apiRef]);

  const onCaptureAnchor = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const anchor: SyncAnchor = {
      synthTick: api.tickPosition,
      audioMs: deckRef.current!.positionMs,
      barIndex: state.currentBarIndex,
      barOccurence: 0,
    };
    setDoc((d) => ({ ...d, syncAnchors: [...d.syncAnchors, anchor], updatedAt: Date.now() }));
  }, [apiRef, state.currentBarIndex]);

  /**
   * Put a finished result on the song it was computed for.
   *
   * Separation runs for minutes, and the YouTube pipeline longer. Applying the result to
   * "whatever is open now" would land one song's stems on another if you looked at a different
   * song in the meantime — so it goes to the song by id, straight to storage if it is closed.
   */
  const applyToSong = useCallback(async (songId: string, patch: Partial<PracticeDoc>) => {
    if (docRef.current.id === songId) {
      setDoc((d) => (d.id === songId ? { ...d, ...patch, updatedAt: Date.now() } : d));
      return;
    }
    const saved = await getSong(songId);
    if (!saved) return;
    await saveSong({ ...saved, ...patch });
    setLibrary(await listSongs());
  }, []);

  /** Bass + backing out of one recording. Throws; the caller decides where to say so. */
  const runSeparation = useCallback(
    async (songId: string, audio: Blob): Promise<StemSet> => {
      setSepBusy(true);
      setSepError(null);
      setSepProgress({ phase: 'decoding', progress: 0 });
      try {
        // The sidecar runs the real demucs with real settings, so prefer it whenever it is
        // there. Loaded lazily either way — a missing onnxruntime-web install must cost this
        // button, not the whole app.
        const separator =
          sidecar?.ready && useSidecar
            ? new SidecarSeparator(sidecarSettings, undefined, sidecar.ffmpeg)
            : (separatorRef.current ??= await loadDemucsSeparator());
        const stems = await separator.separate(audio, setSepProgress);
        await applyToSong(songId, { stems });
        if (docRef.current.id === songId) setSource('bass');
        return stems;
      } catch (e) {
        setSepProgress({ phase: 'error', progress: 0 });
        throw e;
      } finally {
        setSepBusy(false);
      }
    },
    [sidecar, useSidecar, sidecarSettings, applyToSong],
  );

  /**
   * Read a tab off an isolated bass stem and write it into the song's score.
   *
   * Only ever runs on the separated stem — YIN assumes one note at a time, so pointed at a
   * full mix it returns noise. `bpm` is passed in rather than read from state so a run that
   * started from one song can never pick up a tempo typed for another.
   */
  const runTranscription = useCallback(
    async (songId: string, stems: StemSet, title: string, bpm?: number): Promise<AutoTabResult> => {
      setTabBusy(true);
      try {
        // Prefer the trained model on the sidecar when it is there — a learned onset+pitch
        // network is a different class of accuracy from the built-in autocorrelation, and it
        // is the same family of tech behind tab sites' "AI draft" features. Everything after
        // "we have notes" is shared with the local path (notesToAutoTab).
        let result: AutoTabResult;
        if (sidecar?.reachable && sidecar.basicPitch && useSidecar) {
          setTabProgress({ phase: 'analysing', progress: 0.3, message: 'basic-pitch (사이드카)' });
          const raw = await transcribeViaSidecar(stems.bass, undefined, (message) =>
            setTabProgress({ phase: 'analysing', progress: 0.6, message }),
          );
          setTabProgress({ phase: 'transcribing', progress: 0.85, message: '탭으로 정리하는 중' });
          result = notesToAutoTab({
            notes: raw,
            durationMs: stems.durationMs,
            title,
            bpm,
            engine: 'basic-pitch',
          });
        } else {
          result = await transcribeBassStem(stems.bass, { title, bpm, onProgress: setTabProgress });
        }
        await applyToSong(songId, { scoreKind: 'alphatex', scoreData: result.alphaTex });
        if (docRef.current.id === songId) {
          tabDiagRef.current = result;
          setTabResult({
            notes: result.noteCount,
            bpm: result.bpm,
            engine: result.engine,
            confidence: result.meanConfidence,
            stats: result.stats,
          });
        }
        return result;
      } finally {
        setTabBusy(false);
      }
    },
    [sidecar, useSidecar, applyToSong],
  );

  const onSeparate = useCallback(async () => {
    if (!doc.audioBlob) return;
    try {
      await runSeparation(doc.id, doc.audioBlob);
    } catch (e) {
      setSepError(e instanceof Error ? e.message : String(e));
    }
  }, [doc.id, doc.audioBlob, runSeparation]);

  /**
   * The result overwrites the score, which is why it is gated behind a confirmation when
   * there is already an opened file there.
   */
  const onTranscribe = useCallback(async () => {
    const stems = doc.stems;
    if (!stems) return;
    if (!isBlankScore(doc.scoreData) && doc.scoreKind === 'gp') {
      if (!window.confirm('불러온 악보를 자동 채보 결과로 덮어씁니다. 계속할까요?')) return;
    }
    setSepError(null);
    const typedBpm = Number(tabBpm);
    const bpm = Number.isFinite(typedBpm) && typedBpm > 0 ? typedBpm : undefined;
    try {
      await runTranscription(doc.id, stems, doc.title, bpm);
    } catch (e) {
      setSepError(`채보 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc.id, doc.stems, doc.title, doc.scoreData, doc.scoreKind, tabBpm, runTranscription]);

  /**
   * YouTube link -> audio file -> bass stem -> tab, in one go.
   *
   * Each step is the same code the individual buttons run; this only chains them and keeps
   * the three-step progress on screen. With `autoPipeline` off it stops after the download,
   * leaving separation and transcription to the buttons as before.
   */
  const onImportYouTube = useCallback(
    async (url: string) => {
      const auto = autoPipeline;
      let step: PipelineStep = 'download';
      setPipeline({ step, auto, progress: 0, message: '사이드카에 요청하는 중' });
      try {
        const download = await downloadFromYouTube(url, (progress, message) =>
          setPipeline({ step: 'download', auto, progress, message }),
        );

        // An untouched "새 곡" is taken over rather than left behind as an empty row.
        const open = docRef.current;
        const reuse = open.id !== DEMO_DOC_ID && !open.audioBlob && isBlankScore(open.scoreData);
        const song = newPracticeDoc({
          id: reuse ? open.id : crypto.randomUUID(),
          title: download.title,
          artist: download.artist,
          scoreKind: 'alphatex',
          scoreData: blankAlphaTex(8, 120, download.title),
          audioBlob: download.file,
          audioFileName: download.file.name,
          sourceUrl: download.url,
        });
        // Saved now rather than through the debounced autosave, so the song is in the library
        // before the long steps start — results from them are applied to it by id.
        await saveSong(song);
        setLibrary(await listSongs());
        setDoc(song);
        setSpeed(1);
        setSource('original');
        setTabBpm('');
        setTabResult(null);
        tabDiagRef.current = null;
        setSepError(null);
        setSepProgress(IDLE_PROGRESS);

        if (!auto) {
          setPipeline({ step: 'done', auto, progress: 1 });
          return;
        }

        step = 'separate';
        setPipeline({ step, auto, progress: 0 });
        const stems = await runSeparation(song.id, download.file);

        step = 'transcribe';
        setPipeline({ step, auto, progress: 0 });
        await runTranscription(song.id, stems, song.title);

        setPipeline({ step: 'done', auto, progress: 1 });
      } catch (e) {
        setPipeline({ step, auto, progress: 0, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [autoPipeline, runSeparation, runTranscription],
  );

  /**
   * Rewrite the last transcription at half or double the tempo.
   *
   * Halving and doubling describe the *same* grid — the onsets cannot say which is right,
   * because both are. Whether 200ms gaps are eighths at 146 or sixteenths at 73 is a notation
   * choice, and the person who knows the song settles it in one click. The search picks the
   * reading a musician would more often write; this is the escape hatch when it picked wrong.
   *
   * Costs milliseconds because it reuses the notes already detected. Re-running the detector
   * would mean minutes and would find exactly the same notes.
   */
  const onRescaleTempo = useCallback(
    (factor: number) => {
      const previous = tabDiagRef.current;
      if (!previous) return;
      const result = notesToAutoTab({
        notes: previous.detectedNotes.map((n) => ({
          midi: n.midi,
          startMs: n.startMs,
          endMs: n.endMs,
          confidence: n.confidence,
        })),
        durationMs: previous.durationMs,
        title: doc.title,
        bpm: previous.bpm * factor,
        engine: previous.engine,
      });
      setDoc((d) => ({
        ...d,
        scoreKind: 'alphatex',
        scoreData: result.alphaTex,
        updatedAt: Date.now(),
      }));
      tabDiagRef.current = result;
      setTabBpm(String(Math.round(result.bpm)));
      setTabResult({
        notes: result.noteCount,
        bpm: result.bpm,
        engine: result.engine,
        confidence: result.meanConfidence,
        stats: result.stats,
      });
    },
    [doc.title],
  );

  /**
   * Download everything the last transcription actually heard, as JSON.
   *
   * Debugging a transcription by looking at the rendered tab is guesswork — was the pitch
   * wrong, the octave, the timing, or just the layout? This file answers that: every kept
   * note with its time and confidence, plus the grid fit and the gate statistics.
   */
  const onExportTabDiagnostics = useCallback(() => {
    const result = tabDiagRef.current;
    if (!result) return;
    const payload = {
      title: doc.title,
      generatedAt: new Date().toISOString(),
      // Which detector heard these. Without it a diagnostic file cannot be read back with
      // any confidence — the two engines want different handling downstream, and guessing
      // from the frame count is exactly the guesswork this file exists to end.
      engine: result.engine,
      bpm: result.bpm,
      noteCount: result.noteCount,
      meanConfidence: result.meanConfidence,
      durationMs: result.durationMs,
      stats: result.stats,
      detectedNotes: result.detectedNotes,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${doc.title.replace(/[\\/:*?"<>|]/g, '_')}-채보진단.json`);
  }, [doc.title]);

  /* -------------------------------------------- each step's result as a file */

  const onSaveAudio = useCallback(() => {
    if (!doc.audioBlob) return;
    downloadBlob(doc.audioBlob, doc.audioFileName ?? `${fileSafe(doc.title) || 'audio'}.m4a`);
  }, [doc.audioBlob, doc.audioFileName, doc.title]);

  const onSaveBass = useCallback(() => {
    if (!doc.stems) return;
    downloadBlob(doc.stems.bass, `${fileSafe(doc.title) || 'song'}-bass.wav`);
  }, [doc.stems, doc.title]);

  const onExportTab = useCallback(() => {
    const bytes = exportGuitarPro();
    if (!bytes) {
      setSaveError('탭 저장 실패: 악보가 아직 로드되지 않았습니다.');
      return;
    }
    downloadBlob(
      new Blob([bytes.slice()], { type: 'application/octet-stream' }),
      `${fileSafe(doc.title) || 'tab'}.gp`,
    );
  }, [exportGuitarPro, doc.title]);

  const onImportBass = useCallback(
    async (file: File) => {
      if (!doc.audioBlob) return;
      setSepBusy(true);
      setSepError(null);
      try {
        const { stems, clipped } = await importBassStem(doc.audioBlob, file, setSepProgress);
        setDoc((d) => ({ ...d, stems, updatedAt: Date.now() }));
        setSource('bass');
        if (clipped) {
          setSepError('반주 트랙이 살짝 클리핑됐습니다. 같은 Demucs 실행에서 나온 파일이 맞는지 확인하세요.');
        }
      } catch (e) {
        setSepError(e instanceof Error ? e.message : String(e));
      } finally {
        setSepBusy(false);
      }
    },
    [doc.audioBlob],
  );

  const onPickScore = useCallback(async (file: File) => {
    const buf = await file.arrayBuffer();
    const fresh = newPracticeDoc({
      title: file.name.replace(/\.[^.]+$/, ''),
      scoreKind: 'gp',
      scoreData: buf,
      scoreFileName: file.name,
    });
    setDoc(fresh);
    await saveSong(fresh);
    setLibrary(await listSongs());
  }, []);

  const onOpenSong = useCallback(async (id: string) => {
    const target = await getSong(id).catch(() => undefined);
    if (target) {
      setDoc(target);
      setSpeed(target.lastSpeed);
      setSource(target.lastSource);
    }
  }, []);

  /**
   * Start a blank song.
   *
   * Without this the only way to begin was to pile audio onto the starter exercise, which
   * left people with their own recording attached to a song called "Warm-up: Position
   * Shifts" and a tab that had nothing to do with it.
   */
  const onNewSong = useCallback(() => {
    const fresh = newPracticeDoc({
      title: '새 곡',
      scoreKind: 'alphatex',
      scoreData: BLANK_ALPHATEX,
    });
    setDoc(fresh);
    setSpeed(1);
    setSource('synth');
  }, []);

  const onExportSong = useCallback(async () => {
    try {
      downloadBlob(await encodeSongFile(doc), songFileName(doc));
    } catch (e) {
      setSaveError(`내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc]);

  const onImportSong = useCallback(async (file: File) => {
    try {
      const imported = await decodeSongFile(file);
      // A fresh id, so importing a backup never overwrites the song you are working on.
      const fresh: PracticeDoc = { ...imported, id: crypto.randomUUID(), updatedAt: Date.now() };
      await saveSong(fresh);
      setDoc(fresh);
      setSpeed(fresh.lastSpeed);
      setSource(fresh.lastSource);
      setLibrary(await listSongs());
      setSaveError(null);
    } catch (e) {
      setSaveError(`가져오기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        onPlayPause();
      }
      if (e.code === 'BracketLeft') setSpeed((s) => Math.max(0.25, Number((s - 0.05).toFixed(2))));
      if (e.code === 'BracketRight') setSpeed((s) => Math.min(1.25, Number((s + 0.05).toFixed(2))));
      if (e.code === 'KeyS' && deckUsable) {
        setSource((s) => (s === 'synth' ? 'original' : 'synth'));
      }
      if (e.code === 'KeyB' && hasStems && deckUsable) {
        setSource((s) => (s === 'bass' ? 'minusBass' : 'bass'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPlayPause, deckUsable, hasStems]);

  /* --------------------------------------------------------------- render */

  // Separation and transcription already report their own progress; the pipeline shows the
  // same numbers rather than inventing a second set.
  const pipelineView: PipelineState | null =
    pipeline && !pipeline.error && pipeline.step === 'separate'
      ? { ...pipeline, progress: sepProgress.progress, message: sepProgress.message }
      : pipeline && !pipeline.error && pipeline.step === 'transcribe'
        ? { ...pipeline, progress: tabProgress?.progress ?? 0, message: tabProgress?.message }
        : pipeline;
  const pipelineBusy = !!pipeline && pipeline.step !== 'done' && !pipeline.error;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">𝄢</span>
          <div>
            <input
              className="title-input"
              value={doc.title}
              onChange={(e) => patchDoc({ title: e.target.value })}
              placeholder="곡 이름"
              aria-label="곡 이름"
            />
            <p className="dim tiny">
              {doc.audioFileName ?? '원본 음원 없음'}
              {hasStems ? ' · 스템 있음' : ''}
              {state.soundFontReady ? '' : ' · 사운드폰트 로딩 중…'}
            </p>
          </div>
        </div>

        <div className="topbar-actions">
          <button className="btn" onClick={onNewSong}>
            새 곡
          </button>
          <FilePick accept=".gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml" onPick={onPickScore}>
            악보 열기
          </FilePick>
          <FilePick
            accept="audio/*,video/*"
            onPick={(f) =>
              attachToSong(
                { audioBlob: f, audioFileName: f.name, stems: undefined },
                f.name.replace(/\.[^.]+$/, ''),
              )
            }
          >
            원본 음원
          </FilePick>
          <button
            className="btn"
            onClick={onExportTab}
            title="Guitar Pro 파일로 저장 — Guitar Pro, TuxGuitar, MuseScore에서 열립니다"
          >
            탭 저장 (.gp)
          </button>
          <button className={`btn toggle ${tabOnly ? 'on' : ''}`} onClick={() => setTabOnly((v) => !v)}>
            탭만
          </button>
        </div>
      </header>

      {state.error && <div className="error-bar">{state.error}</div>}
      {saveError && (
        <div className="error-bar">
          {saveError}
          <button className="link" onClick={() => setSaveError(null)}>
            닫기
          </button>
        </div>
      )}

      <div className="body">
        <main className="stage">
          <div className="viewport" ref={viewportRef}>
            <div className="at-container" ref={containerRef} />
          </div>

          <div className="dock">
            <Transport
              state={state}
              speed={speed}
              looping={looping}
              metronome={metronome}
              countIn={countIn}
              onPlayPause={onPlayPause}
              onStop={onStop}
              onSpeed={setSpeed}
              onToggleLoop={() => setLooping((v) => !v)}
              onToggleMetronome={() => setMetronome((v) => !v)}
              onToggleCountIn={() => setCountIn((v) => !v)}
            />
            <SourceToggle
              source={effectiveSource}
              hasAudio={hasAudio}
              hasStems={hasStems}
              onSource={setSource}
            />
          </div>
        </main>

        <aside className="sidebar">
          <YouTubePanel
            sidecar={sidecar}
            pipeline={pipelineView}
            busy={pipelineBusy || sepBusy || tabBusy}
            auto={autoPipeline}
            onAuto={setAutoPipeline}
            onImport={onImportYouTube}
            onRecheck={recheckSidecar}
            audioFileName={hasAudio ? (doc.audioFileName ?? '원본 음원') : null}
            sourceUrl={doc.sourceUrl ?? null}
            onSaveAudio={onSaveAudio}
          />

          <StemPanel
            hasAudio={hasAudio}
            stems={doc.stems}
            capability={capability}
            diagnosis={isolationDiag}
            busy={sepBusy}
            progress={sepProgress}
            error={sepError}
            onSeparate={onSeparate}
            tabBusy={tabBusy}
            tabProgress={tabProgress}
            tabResult={tabResult}
            onTranscribe={onTranscribe}
            tabBpm={tabBpm}
            onTabBpm={setTabBpm}
            onExportDiagnostics={onExportTabDiagnostics}
            onRescaleTempo={onRescaleTempo}
            sidecar={sidecar}
            sidecarSettings={sidecarSettings}
            useSidecar={useSidecar}
            onToggleSidecar={() => setUseSidecar((v) => !v)}
            onSidecarSettings={(patch) => setSidecarSettings((s) => ({ ...s, ...patch }))}
            onImportBass={onImportBass}
            onSaveBass={onSaveBass}
            onExportTab={onExportTab}
            onDelete={() => {
              patchDoc({ stems: undefined });
              setSepProgress(IDLE_PROGRESS);
              setSepError(null);
            }}
          />

          <SyncPanel
            anchors={doc.syncAnchors}
            currentTick={state.position.currentTick}
            currentBarIndex={state.currentBarIndex}
            ticksPerQuarter={state.ticksPerQuarter}
            scoreBpm={state.scoreBpm}
            hasAudio={hasAudio}
            driftMs={drift.ms}
            driftAction={drift.action}
            anchorMode={anchorMode}
            audioPositionMs={audioPos.ms}
            audioDurationMs={audioPos.durationMs}
            audioPlaying={audioPos.playing}
            onToggleAnchorMode={() => setAnchorMode((v) => !v)}
            onAudioPlayPause={() => {
              const deck = deckRef.current!;
              if (deck.isPaused) void deck.play();
              else deck.pause();
            }}
            onAudioSeek={(ms) => deckRef.current!.seek(ms)}
            onAudioNudge={(d) => deckRef.current!.seek(deckRef.current!.positionMs + d)}
            onCapture={onCaptureAnchor}
            onRemove={(a) =>
              setDoc((d) => ({ ...d, syncAnchors: d.syncAnchors.filter((x) => x !== a), updatedAt: Date.now() }))
            }
            onClear={() => patchDoc({ syncAnchors: [] })}
            onSeekToAnchor={(a) => {
              if (anchorMode) deckRef.current!.seek(a.audioMs);
              else if (apiRef.current) apiRef.current.tickPosition = a.synthTick;
            }}
          />

          {state.trackNames.length > 1 && (
            <section className="panel">
              <header className="panel-head">
                <h3>트랙</h3>
              </header>
              <ul className="track-list">
                {state.trackNames.map((n, i) => (
                  <li key={i}>
                    <button
                      className={`link ${i === doc.trackIndex ? 'on' : ''}`}
                      onClick={() => {
                        patchDoc({ trackIndex: i });
                        setTrack(i);
                      }}
                    >
                      {n}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <header className="panel-head">
              <h3>내 곡</h3>
              {storage && (
                <span className={`badge ${storage.persisted ? 'ok' : 'off'}`}>
                  {storage.persisted ? '영구 저장' : '삭제될 수 있음'}
                </span>
              )}
            </header>

            {storage && storage.quotaBytes > 0 && (
              <p className="hint tiny">
                {fmtBytes(storage.usageBytes)} / {fmtBytes(storage.quotaBytes)} 사용
                {!storage.persisted && ' · 디스크가 부족해지면 브라우저가 지울 수 있습니다'}
              </p>
            )}

            <div className="song-actions">
              <button className="btn tiny" onClick={onExportSong}>
                이 곡 내보내기
              </button>
              <FilePick accept=".bassprac" onPick={onImportSong} tiny>
                곡 가져오기
              </FilePick>
            </div>
            {library.length === 0 ? (
              <p className="hint">악보를 열면 여기에 저장됩니다.</p>
            ) : (
              <ul className="song-list">
                {library.map((s) => (
                  <li key={s.id}>
                    <button className={`link ${s.id === doc.id ? 'on' : ''}`} onClick={() => onOpenSong(s.id)}>
                      {s.title}
                    </button>
                    <button
                      className="link danger"
                      onClick={async () => {
                        await deleteSong(s.id);
                        setLibrary(await listSongs());
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <header className="panel-head">
              <h3>단축키</h3>
            </header>
            <ul className="keys">
              <li>
                <kbd>Space</kbd> 재생 / 정지
              </li>
              <li>
                <kbd>[</kbd> <kbd>]</kbd> 속도 ∓5%
              </li>
              <li>
                <kbd>S</kbd> 원본 ↔ 신디
              </li>
              <li>
                <kbd>B</kbd> 베이스만 ↔ 반주만
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Hand a blob to the browser as a file download. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Revoke late: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 / 1024)} MB`;
}

function FilePick({
  accept,
  onPick,
  children,
  tiny,
}: {
  accept: string;
  onPick: (f: File) => void;
  children: React.ReactNode;
  tiny?: boolean;
}) {
  const id = useMemo(() => `fp-${Math.random().toString(36).slice(2)}`, []);
  return (
    <>
      <label className={`btn ${tiny ? 'tiny' : ''}`} htmlFor={id}>
        {children}
      </label>
      <input
        id={id}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

import { useState } from 'react';
import type { SidecarInfo } from '../lib/sidecar';
import { parseYouTubeUrl } from '../lib/youtube';

/** The three steps from a recording to a tab, in order. */
export type PipelineStep = 'download' | 'separate' | 'transcribe';

/** Where the recording came from — decides how the first step is described. */
export type PipelineSource = 'file' | 'youtube';

export interface PipelineState {
  source: PipelineSource;
  /** The step running now, 'done' once everything asked for has finished. */
  step: PipelineStep | 'done';
  /** Whether separation and transcription follow the first step. */
  auto: boolean;
  /** 0..1 within the current step. */
  progress: number;
  message?: string;
  /** Set when a step failed; `step` is then the one that failed. */
  error?: string;
}

const FIRST_STEP_LABEL: Record<PipelineSource, string> = {
  file: '음원 불러오기',
  youtube: '음원 받기',
};

const LATER_STEPS: { key: PipelineStep; label: string }[] = [
  { key: 'separate', label: '베이스 분리' },
  { key: 'transcribe', label: '탭 생성' },
];

export interface StartPanelProps {
  sidecar: SidecarInfo | null;
  pipeline: PipelineState | null;
  busy: boolean;
  auto: boolean;
  onAuto: (auto: boolean) => void;
  /** Start a new song from an audio file — needs nothing installed. */
  onImportFile: (file: File) => void;
  /** Start a new song from a YouTube link — needs the local helper with yt-dlp. */
  onImportYouTube: (url: string) => void;
  /** The helper is probed once on load; this asks again after it has been started. */
  onRecheck: () => void;
  /** The open song's recording, null when it has none. */
  audioFileName: string | null;
  /** The link the open song's recording came from, if it came from one. */
  sourceUrl: string | null;
  onSaveAudio: () => void;
}

/**
 * Where a song starts: a recording in, and (optionally) the whole way to a tab.
 *
 * The file path is the one everybody has — separation and transcription both run in the
 * page, so it works with nothing installed. A YouTube link needs a local helper (the browser
 * cannot read YouTube's audio), so that field only appears once one is found.
 */
export function StartPanel(props: StartPanelProps) {
  const canYouTube = !!props.sidecar?.reachable && !!props.sidecar.ytdlp;

  return (
    <section className="panel start-panel">
      <header className="panel-head">
        <h3>음원으로 시작</h3>
        {canYouTube && <span className="badge ok">YouTube 사용 가능</span>}
      </header>

      <label className={`btn btn-primary wide ${props.busy ? 'disabled' : ''}`} htmlFor="start-file">
        음원 파일 고르기
      </label>
      <input
        id="start-file"
        type="file"
        accept="audio/*,video/*"
        hidden
        disabled={props.busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onImportFile(f);
          e.target.value = '';
        }}
      />
      <p className="hint tiny">mp3 · m4a · wav · flac, 영상 파일도 됩니다. 설치 없이 이 브라우저 안에서 처리됩니다.</p>

      {canYouTube && <YouTubeRow busy={props.busy} onImport={props.onImportYouTube} />}

      <label className="auto-row">
        <input
          type="checkbox"
          checked={props.auto}
          onChange={(e) => props.onAuto(e.target.checked)}
          disabled={props.busy}
        />
        <span>베이스 분리 → 탭 생성까지 자동으로</span>
      </label>

      {props.pipeline && <PipelineSteps pipeline={props.pipeline} />}

      {props.audioFileName && !props.busy && (
        <div className="audio-file-row">
          <span className="dim tiny" title={props.sourceUrl ?? undefined}>
            {props.sourceUrl ? '받은 음원' : '음원'}: {props.audioFileName}
          </span>
          <button className="btn tiny" type="button" onClick={props.onSaveAudio}>
            파일로 저장
          </button>
        </div>
      )}

      {!canYouTube && <YouTubeUnavailable sidecar={props.sidecar} onRecheck={props.onRecheck} />}
      {canYouTube && !props.sidecar?.ytdlpEjs && (
        <p className="hint tiny">
          YouTube가 실패하면 도우미 쪽 Python에 <code>pip install -U "yt-dlp[default]"</code> 후 도우미를
          재시작하세요 (영상 주소 해독기가 빠져 있습니다).
        </p>
      )}
    </section>
  );
}

function YouTubeRow({ busy, onImport }: { busy: boolean; onImport: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const link = parseYouTubeUrl(url);
  return (
    <>
      {/* noValidate: the browser's own url check rejects a pasted "youtu.be/…" without a
          scheme, which parseYouTubeUrl accepts — and it would block the submit silently. */}
      <form
        className="url-row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (link && !busy) onImport(link.url);
        }}
      >
        <input
          type="url"
          inputMode="url"
          placeholder="또는 YouTube 링크 https://youtu.be/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          aria-label="YouTube 링크"
        />
        <button className="btn" type="submit" disabled={!link || busy}>
          가져오기
        </button>
      </form>
      {url.trim() !== '' && !link && <p className="hint warn tiny">YouTube 영상 링크가 아닙니다.</p>}
    </>
  );
}

function PipelineSteps({ pipeline }: { pipeline: PipelineState }) {
  const all = [{ key: 'download' as PipelineStep, label: FIRST_STEP_LABEL[pipeline.source] }, ...LATER_STEPS];
  const steps = pipeline.auto ? all : all.slice(0, 1);
  const current = pipeline.step === 'done' ? steps.length : steps.findIndex((s) => s.key === pipeline.step);

  return (
    <ol className="pipeline">
      {steps.map((s, i) => {
        const state =
          i < current ? 'done' : i === current ? (pipeline.error ? 'error' : 'active') : 'todo';
        return (
          <li key={s.key} className={`pipeline-step ${state}`}>
            <div className="phase-line">
              <span>
                <span className="step-mark">{state === 'done' ? '✓' : state === 'error' ? '✕' : i + 1}</span>
                {s.label}
              </span>
              {state === 'active' && <span className="dim tiny">{pipeline.message}</span>}
            </div>
            {state === 'active' && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, pipeline.progress)) * 100)}%` }}
                />
              </div>
            )}
            {state === 'error' && <p className="hint warn">{pipeline.error}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Why there is no link field, kept out of the way: everything else works without the helper,
 * so this is a footnote, not a warning.
 */
function YouTubeUnavailable({ sidecar, onRecheck }: { sidecar: SidecarInfo | null; onRecheck: () => void }) {
  if (!sidecar) return null;
  return (
    <details className="youtube-help">
      <summary>YouTube 링크로 가져오려면</summary>
      <p className="hint">
        브라우저는 YouTube 음원을 직접 읽을 수 없어서, 링크 가져오기는 이 컴퓨터에서 도는 도우미
        프로그램이 있을 때만 켜집니다.{' '}
        {sidecar.reachable ? (
          <>
            도우미는 찾았는데 yt-dlp가 없습니다: <code>pip install -U "yt-dlp[default]"</code> 후 재시작.
          </>
        ) : (
          <>
            프로젝트 폴더에서 <code>start.bat</code> 또는 <code>npm run sidecar</code>로 띄울 수 있습니다.
          </>
        )}{' '}
        <button className="link" type="button" onClick={onRecheck}>
          다시 확인
        </button>
      </p>
    </details>
  );
}

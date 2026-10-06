import { useState } from 'react';
import type { SidecarInfo } from '../lib/sidecar';
import { parseYouTubeUrl } from '../lib/youtube';

/** The three steps from a link to a tab, in order. */
export type PipelineStep = 'download' | 'separate' | 'transcribe';

export interface PipelineState {
  /** The step running now, 'done' once everything asked for has finished. */
  step: PipelineStep | 'done';
  /** Whether separation and transcription follow the download. */
  auto: boolean;
  /** 0..1 within the current step. */
  progress: number;
  message?: string;
  /** Set when a step failed; `step` is then the one that failed. */
  error?: string;
}

const STEPS: { key: PipelineStep; label: string }[] = [
  { key: 'download', label: '음원 받기' },
  { key: 'separate', label: '베이스 분리' },
  { key: 'transcribe', label: '탭 생성' },
];

export interface YouTubePanelProps {
  sidecar: SidecarInfo | null;
  pipeline: PipelineState | null;
  busy: boolean;
  auto: boolean;
  onAuto: (auto: boolean) => void;
  onImport: (url: string) => void;
  /** The sidecar is probed once on load; this asks again after it has been started. */
  onRecheck: () => void;
  /** The open song's recording, null when it has none. */
  audioFileName: string | null;
  /** The link the open song's recording came from, if it came from one. */
  sourceUrl: string | null;
  onSaveAudio: () => void;
}

export function YouTubePanel(props: YouTubePanelProps) {
  const [url, setUrl] = useState('');
  const link = parseYouTubeUrl(url);
  const canDownload = !!props.sidecar?.reachable && !!props.sidecar.ytdlp;

  const submit = () => {
    if (link && canDownload && !props.busy) props.onImport(link.url);
  };

  return (
    <section className="panel youtube-panel">
      <header className="panel-head">
        <h3>YouTube 링크로 시작</h3>
        {props.sidecar?.ytdlp && <span className="badge ok">yt-dlp</span>}
      </header>

      {/* noValidate: the browser's own url check rejects a pasted "youtu.be/…" without a
          scheme, which parseYouTubeUrl accepts — and it would block the submit silently. */}
      <form
        className="url-row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="url"
          inputMode="url"
          placeholder="https://youtu.be/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={props.busy}
          aria-label="YouTube 링크"
        />
        <button className="btn btn-primary" type="submit" disabled={!link || !canDownload || props.busy}>
          가져오기
        </button>
      </form>
      {url.trim() !== '' && !link && <p className="hint warn tiny">YouTube 영상 링크가 아닙니다.</p>}

      <label className="auto-row">
        <input
          type="checkbox"
          checked={props.auto}
          onChange={(e) => props.onAuto(e.target.checked)}
          disabled={props.busy}
        />
        <span>받은 뒤 베이스 분리 → 탭 생성까지 자동으로</span>
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

      <SidecarHint sidecar={props.sidecar} onRecheck={props.onRecheck} />
    </section>
  );
}

function PipelineSteps({ pipeline }: { pipeline: PipelineState }) {
  const steps = pipeline.auto ? STEPS : STEPS.slice(0, 1);
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

/** Say exactly what is missing for the link to work, since nothing here works without it. */
function SidecarHint({ sidecar, onRecheck }: { sidecar: SidecarInfo | null; onRecheck: () => void }) {
  if (!sidecar) return null;
  if (sidecar.reachable && sidecar.ytdlp) {
    return sidecar.ytdlpEjs ? null : (
      <p className="hint tiny">
        YouTube가 실패하면 사이드카 쪽 Python에 <code>pip install -U "yt-dlp[default]"</code> 후 사이드카를
        재시작하세요 (영상 주소 해독기가 빠져 있습니다).
      </p>
    );
  }
  return (
    <div className="hint warn">
      {sidecar.reachable ? (
        <>
          사이드카에 yt-dlp가 없습니다. <code>pip install -U "yt-dlp[default]"</code> 후 사이드카를 재시작하세요.
        </>
      ) : (
        <>
          YouTube에서 받으려면 로컬 사이드카가 필요합니다 (브라우저는 YouTube 음원을 직접 못 읽습니다).{' '}
          <code>start.bat</code> 또는 <code>npm run sidecar</code>로 띄우세요.
        </>
      )}{' '}
      <button className="link" type="button" onClick={onRecheck}>
        다시 확인
      </button>
    </div>
  );
}

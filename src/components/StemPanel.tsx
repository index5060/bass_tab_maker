import type { SeparationProgress, StemSet } from '../lib/stems';
import type { IsolationDiagnosis, SeparationCapability } from '../lib/separator';
import type { TabProgress, TabSummary } from '../lib/tab/client';
import type { SidecarInfo, SidecarSettings } from '../lib/sidecar';
import { AUDIO_FILE_ACCEPT } from '../lib/audioImport';

const MODE_LABEL: Record<'webgpu' | 'wasm-threaded' | 'wasm-single', string> = {
  webgpu: 'WebGPU',
  'wasm-threaded': 'CPU 멀티스레드',
  'wasm-single': 'CPU 단일 스레드',
};

const PHASE_LABEL: Record<SeparationProgress['phase'], string> = {
  idle: '',
  'loading-model': '모델 준비',
  decoding: '디코딩',
  separating: '분리 중',
  encoding: '저장 중',
  done: '완료',
  error: '실패',
};

export interface StemPanelProps {
  hasAudio: boolean;
  stems: StemSet | undefined;
  /** null while still being probed (WebGPU detection is async). */
  capability: SeparationCapability | null;
  /** Filled in only when isolation is off — explains why, from the page's own point of view. */
  diagnosis: IsolationDiagnosis | null;
  busy: boolean;
  progress: SeparationProgress;
  error: string | null;
  onSeparate: () => void;
  onImportBass: (file: File) => void;
  /** Download the isolated bass as a WAV file. */
  onSaveBass: () => void;
  /** Download the score on screen as a Guitar Pro file. */
  onExportTab: () => void;
  onDelete: () => void;

  /** Automatic transcription of the isolated bass stem. */
  tabBusy: boolean;
  tabProgress: TabProgress | null;
  /** The tab on screen, when it was made for this song in this session. */
  tabResult: TabSummary | null;
  onTranscribe: () => void;
  /** User-typed BPM for transcription; empty string means find it. */
  tabBpm: string;
  onTabBpm: (value: string) => void;
  /** Download what the analysis heard, for debugging a bad tab. */
  onExportDiagnostics: () => void;
  /** Listen again at half or double the tempo. */
  onRescaleTempo: (factor: number) => void;
  /** Same notes, different bars: "one" a beat earlier/later, or another metre. */
  onRelayout: (change: { shiftBeats?: number; beatsPerBar?: number }) => void;

  /** Local sidecar running the real demucs. null while probing, never an error. */
  sidecar: SidecarInfo | null;
  sidecarSettings: SidecarSettings;
  useSidecar: boolean;
  onToggleSidecar: () => void;
  onSidecarSettings: (patch: Partial<SidecarSettings>) => void;
}

export function StemPanel(props: StemPanelProps) {
  const { stems, progress } = props;

  return (
    <section className="panel stem-panel">
      <header className="panel-head">
        <h3>스템 분리</h3>
        {stems && <span className="badge ok">준비됨</span>}
      </header>

      {!props.hasAudio ? (
        <p className="hint">
          원본 음원을 먼저 불러오세요 — 위에 YouTube 링크를 넣거나 상단의 "원본 음원"으로 파일을
          고르면 됩니다. 거기서 베이스를 뽑아냅니다.
        </p>
      ) : stems ? (
        <>
          <p className="hint">
            베이스와 반주가 분리되어 있습니다. 아래 소스 버튼에서 골라 들으세요.
          </p>
          <dl className="readout">
            <div>
              <dt>모델</dt>
              <dd>{stems.model}</dd>
            </div>
            <div>
              <dt>용량</dt>
              <dd>{fmtMb(stems.bass.size + stems.minusBass.size)}</dd>
            </div>
          </dl>
          <button className="btn tiny" onClick={props.onSaveBass}>
            베이스 WAV 저장
          </button>
          {props.tabBusy ? (
            <div className="separating">
              <div className="phase-line">
                <strong>탭 만드는 중</strong>
                <span className="dim tiny">{props.tabProgress?.message}</span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.round((props.tabProgress?.progress ?? 0) * 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="bpm-row">
                <span>템포(BPM)</span>
                <input
                  type="number"
                  min={30}
                  max={300}
                  placeholder="자동"
                  value={props.tabBpm}
                  onChange={(e) => props.onTabBpm(e.target.value)}
                />
                <span className="dim tiny">아는 값이 있으면 입력 — 비워 두면 반주에서 찾습니다</span>
              </div>
              <button className="btn btn-primary wide" onClick={props.onTranscribe}>
                베이스 탭 자동 생성
              </button>
              {props.tabResult ? (
                props.tabResult.notes === 0 ? (
                  <div className="isolation-diag">
                    <p className="hint warn">
                      <strong>음표를 하나도 찾지 못했습니다.</strong> 베이스 스템이 거의 무음이거나
                      음정이 잡히지 않았습니다. 스템을 들어 보고, 비어 있으면 다시 분리해 보세요.
                    </p>
                    <button className="btn tiny" onClick={props.onExportDiagnostics}>
                      채보 진단 JSON 저장
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="hint">
                      음표 <strong>{props.tabResult.notes}개</strong> · <strong>{props.tabResult.bpm} BPM</strong>
                      {props.tabResult.pinnedBpm ? ' (입력값)' : ''} · {props.tabResult.beatsPerBar}/4박자 ·{' '}
                      {props.tabResult.bars}마디. 박은{' '}
                      {props.tabResult.beatSource === 'band' ? '반주(드럼)에서' : '베이스에서'}, 음은 베이스
                      스템에서 읽었고, 마디마다 원곡과 싱크가 맞춰져 있습니다.
                    </p>
                    {tabWarnings(props.tabResult).map((warning) => (
                      <p className="hint warn" key={warning}>
                        {warning}
                      </p>
                    ))}

                    {/*
                      Where "one" is and which tempo level is the beat are the two calls the
                      analysis can get wrong while every note is right. Both are one click:
                      moving the bar lines is instant (same notes), changing the tempo level
                      listens again with the period pinned.
                    */}
                    <div className="row gap">
                      <span className="dim tiny">마디 시작</span>
                      <button className="btn tiny" onClick={() => props.onRelayout({ shiftBeats: -1 })}>
                        ← 한 박 앞으로
                      </button>
                      <button className="btn tiny" onClick={() => props.onRelayout({ shiftBeats: 1 })}>
                        한 박 뒤로 →
                      </button>
                      <button
                        className="btn tiny"
                        onClick={() => props.onRelayout({ beatsPerBar: props.tabResult!.beatsPerBar === 3 ? 4 : 3 })}
                      >
                        {props.tabResult.beatsPerBar === 3 ? '4/4로' : '3/4로'}
                      </button>
                    </div>
                    <div className="row gap">
                      <span className="dim tiny">음표가 두 배로 길거나 짧으면</span>
                      <button className="btn tiny" onClick={() => props.onRescaleTempo(0.5)}>
                        템포 ÷2
                      </button>
                      <button className="btn tiny" onClick={() => props.onRescaleTempo(2)}>
                        템포 ×2
                      </button>
                    </div>

                    <div className="row gap">
                      <button className="btn tiny" onClick={props.onExportTab}>
                        탭 파일 저장 (.gp)
                      </button>
                      <button className="btn tiny" onClick={props.onExportDiagnostics}>
                        채보 진단 JSON 저장
                      </button>
                    </div>
                  </>
                )
              ) : (
                <p className="hint">
                  반주에서 박자를 찾고, 그 박마다 16분음표 칸으로 나눠 베이스 스템에서 음을 읽어
                  4현 베이스 탭(E A D G)으로 적습니다. 슬라이드·해머온·고스트노트는 평범한
                  음표로 나옵니다.
                </p>
              )}
            </>
          )}

          <button className="btn tiny" onClick={props.onDelete}>
            스템 삭제 후 다시 분리
          </button>
        </>
      ) : props.busy ? (
        <div className="separating">
          <div className="phase-line">
            <strong>{PHASE_LABEL[progress.phase]}</strong>
            <span className="dim tiny">{progress.message}</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.progress)) * 100)}%` }}
            />
          </div>
          <p className="hint">
            곡 하나에 몇 분 걸립니다. 탭 아래로 내려도 계속 돌아가지만, 이 창은 열어두세요.
          </p>
        </div>
      ) : (
        <>
          <p className="hint">
            원본에서 <strong>베이스만</strong>과 <strong>베이스 뺀 반주</strong>를 뽑아냅니다.
            곡당 한 번만 하면 되고 결과는 저장됩니다.
          </p>

          {props.sidecar?.ready && (
            <div className="sidecar-box">
              <label className="sidecar-head">
                <input
                  type="checkbox"
                  checked={props.useSidecar}
                  onChange={props.onToggleSidecar}
                />
                <span>
                  <strong>로컬 사이드카 사용</strong>
                  <span className="dim tiny"> · demucs {props.sidecar.demucs} · {props.sidecar.device}</span>
                </span>
              </label>

              {props.useSidecar && (
                <div className="sidecar-settings">
                  <label>
                    <span>모델</span>
                    <select
                      value={props.sidecarSettings.model}
                      onChange={(e) => props.onSidecarSettings({ model: e.target.value })}
                    >
                      {props.sidecar.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                          {m === 'htdemucs_ft' ? ' (가장 깨끗함, 느림)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>shifts {props.sidecarSettings.shifts}</span>
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={1}
                      value={props.sidecarSettings.shifts}
                      onChange={(e) =>
                        props.onSidecarSettings({ shifts: Number(e.target.value) })
                      }
                    />
                  </label>

                  <label>
                    <span>overlap {props.sidecarSettings.overlap.toFixed(2)}</span>
                    <input
                      type="range"
                      min={0}
                      max={0.9}
                      step={0.05}
                      value={props.sidecarSettings.overlap}
                      onChange={(e) =>
                        props.onSidecarSettings({ overlap: Number(e.target.value) })
                      }
                    />
                  </label>

                  <p className="hint tiny">
                    shifts는 신호를 조금씩 밀어 여러 번 돌린 뒤 평균 냅니다 — 값만큼 시간이
                    곱해지는 대신 이음매가 줄어듭니다. overlap은 구간 경계를 부드럽게 합니다.
                    {props.sidecarSettings.shifts >= 2 && ' 지금 설정은 꽤 오래 걸립니다.'}
                  </p>
                </div>
              )}
            </div>
          )}

          {props.sidecar && !props.sidecar.ready && props.sidecar.reachable && (
            <p className="hint warn">{props.sidecar.reason}</p>
          )}

          <button
            className="btn btn-primary wide"
            onClick={props.onSeparate}
            disabled={!props.capability && !(props.sidecar?.ready && props.useSidecar)}
          >
            {props.sidecar?.ready && props.useSidecar ? '사이드카로 분리하기' : '브라우저에서 분리하기'}
          </button>

          {!(props.sidecar?.ready && props.useSidecar) && props.capability && (
            <p className={`hint mode-line ${props.capability.mode === 'wasm-single' ? 'warn' : ''}`}>
              <strong>{MODE_LABEL[props.capability.mode]}</strong> — {props.capability.note}
            </p>
          )}

          {props.capability?.mode === 'wasm-single' && (
            <details className="isolation-diag">
              <summary>왜 느린 모드인지 / 빠르게 만들기</summary>
              {props.diagnosis && (
                <>
                  <p className="hint">
                    <strong>{props.diagnosis.verdict}</strong>
                  </p>
                  <table className="diag-table">
                    <tbody>
                      <tr>
                        <th>보낸 COOP</th>
                        <td>{props.diagnosis.coop ?? <em>없음</em>}</td>
                      </tr>
                      <tr>
                        <th>보낸 COEP</th>
                        <td>{props.diagnosis.coep ?? <em>없음</em>}</td>
                      </tr>
                      <tr>
                        <th>주소</th>
                        <td>{props.diagnosis.origin}</td>
                      </tr>
                      <tr>
                        <th>보안 컨텍스트</th>
                        <td>{props.diagnosis.isSecureContext ? '예' : '아니오'}</td>
                      </tr>
                      <tr>
                        <th>브라우저</th>
                        <td>{props.diagnosis.browser}</td>
                      </tr>
                    </tbody>
                  </table>
                </>
              )}
              <p className="hint">
                고치기 싫으시면 그냥 두셔도 됩니다 — 느릴 뿐 결과는 같습니다. 급하면 아래
                가져오기 쪽이 훨씬 빠릅니다.
              </p>
            </details>
          )}

          <details className="local-import">
            <summary>이미 분리해둔 파일 가져오기</summary>
            <p className="hint">
              로컬에서 Demucs를 돌리셨다면 <code>bass.wav</code> 하나만 주시면 됩니다. 반주는
              원본에서 베이스를 빼서 계산하므로 나머지 파일은 필요 없습니다. 브라우저 분리보다
              훨씬 빠르고 결과도 좋습니다.
            </p>
            <label className="btn tiny" htmlFor="stem-import">
              bass 스템 파일 고르기
            </label>
            <input
              id="stem-import"
              type="file"
              accept={AUDIO_FILE_ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onImportBass(f);
                e.target.value = '';
              }}
            />
          </details>
        </>
      )}

      {props.error && <p className="hint warn">{props.error}</p>}
    </section>
  );
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Say out loud the ways a finished-looking tab can still be off, so they are checked first.
 */
function tabWarnings(result: TabSummary): string[] {
  const out: string[] = [];
  if (result.downbeatConfidence < 0.25) {
    out.push(
      '마디의 첫 박이 분명하지 않았습니다. 탭이 한 박씩 밀려 보이면 "마디 시작" 버튼으로 옮기세요 — 음은 그대로이고 마디선만 움직입니다.',
    );
  }
  if (Math.abs(result.tuningCents) > 30) {
    out.push(
      `음원이 표준 음높이(A=440)에서 ${Math.round(Math.abs(result.tuningCents))}센트 ${
        result.tuningCents > 0 ? '높게' : '낮게'
      } 녹음돼 있습니다. 가장 가까운 음으로 적었습니다.`,
    );
  }
  if (result.beatSource === 'bass') {
    out.push('반주 스템이 비어 있어 베이스에서 박자를 찾았습니다. 리듬이 어긋나면 템포를 직접 입력해 보세요.');
  }
  return out;
}

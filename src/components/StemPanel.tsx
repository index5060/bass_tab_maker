import type { SeparationProgress, StemSet } from '../lib/stems';
import type { IsolationDiagnosis, SeparationCapability } from '../lib/separator';
import type { AutoTabProgress, AutoTabSummary } from '../lib/autoTab';
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
  tabProgress: AutoTabProgress | null;
  tabResult: AutoTabSummary | null;
  onTranscribe: () => void;
  /** User-typed BPM for transcription; empty string means estimate it. */
  tabBpm: string;
  onTabBpm: (value: string) => void;
  /** Download what the transcriber actually heard, for debugging a bad tab. */
  onExportDiagnostics: () => void;
  /** Rewrite the same notes at half or double tempo — the one call the onsets cannot make. */
  onRescaleTempo: (factor: number) => void;

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
                  placeholder="자동 추정"
                  value={props.tabBpm}
                  onChange={(e) => props.onTabBpm(e.target.value)}
                />
                <span className="dim tiny">아는 값이 있으면 입력 — 자동 추정보다 정확합니다</span>
              </div>
              <button className="btn btn-primary wide" onClick={props.onTranscribe}>
                베이스 탭 자동 생성 (AI)
              </button>
              {props.tabResult ? (
                props.tabResult.notes === 0 ? (
                  <div className="isolation-diag">
                    <p className="hint warn">
                      <strong>음표를 하나도 찾지 못했습니다.</strong> {explainEmpty(props.tabResult)}
                    </p>
                    <table className="diag-table">
                      <tbody>
                        <tr>
                          <th>분석 프레임</th>
                          <td>{props.tabResult.stats.frames}</td>
                        </tr>
                        <tr>
                          <th>유효 프레임</th>
                          <td>{props.tabResult.stats.voicedFrames}</td>
                        </tr>
                        <tr>
                          <th>스템 최대 레벨</th>
                          <td>{props.tabResult.stats.peakBeforeNormalise.toFixed(4)}</td>
                        </tr>
                        <tr>
                          <th>중앙 신뢰도</th>
                          <td>{(props.tabResult.stats.medianConfidence * 100).toFixed(0)}%</td>
                        </tr>
                        <tr>
                          <th>너무 짧아 버림</th>
                          <td>{props.tabResult.stats.droppedTooShort}</td>
                        </tr>
                        <tr>
                          <th>음역 밖이라 버림</th>
                          <td>{props.tabResult.stats.droppedOutOfRange}</td>
                        </tr>
                      </tbody>
                    </table>
                    {/* The empty result is exactly when the raw record matters most — this
                        button used to appear only on success, which meant the one case worth
                        diagnosing was the one case you could not export. */}
                    <button className="btn tiny" onClick={props.onExportDiagnostics}>
                      채보 진단 JSON 저장
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="hint">
                      {props.tabResult.engine === 'basic-pitch' ? 'AI 채보(basic-pitch)' : '내장 채보'}
                      {' — '}음표 <strong>{props.tabResult.notes}개</strong>, 템포{' '}
                      <strong>{props.tabResult.bpm.toFixed(1)} BPM</strong>
                      {props.tabResult.stats.subdivision === 3 ? ' (셔플)' : ''}, 신뢰도{' '}
                      {(props.tabResult.confidence * 100).toFixed(0)}%. 초안이니 귀로 확인하며
                      고치세요.
                    </p>
                    {props.tabResult.fallbackReason && (
                      <p className="hint warn">
                        AI 채보를 쓰지 못해 내장 채보로 만들었습니다 — {props.tabResult.fallbackReason}
                      </p>
                    )}
                    {tabWarnings(props.tabResult).map((warning) => (
                      <p className="hint warn" key={warning}>
                        {warning}
                      </p>
                    ))}

                    {/*
                      Half and double are the same grid — the onsets genuinely cannot say which
                      is right, so this is the user's call, not the algorithm's. Reuses the
                      notes already detected, so it is instant.
                    */}
                    <div className="row gap">
                      <span className="dim tiny">마디가 두 배로 길거나 짧게 느껴지면</span>
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
                    <p className="hint tiny dim">
                      들린 음 전부가 시각·확신도와 함께 저장됩니다. 새로고침하면 사라지니 지금
                      받아두세요.
                    </p>
                  </>
                )
              ) : (
                <p className="hint">
                  분리된 베이스에서 음정을 읽어 탭 초안을 만듭니다. 슬라이드·해머온·고스트노트는
                  구분하지 못하고 평범한 음표로 나옵니다.
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
 * Say where the notes went.
 *
 * A page of rests with no explanation is the worst possible outcome — it looks like the
 * feature is broken when usually one gate was simply set wrong for this material.
 */
function explainEmpty(result: NonNullable<StemPanelProps['tabResult']>): string {
  const s = result.stats;
  if (s.peakBeforeNormalise < 0.001) {
    return '스템이 사실상 무음입니다. 분리가 베이스를 못 잡았을 수 있으니 다시 분리해 보세요.';
  }
  if (s.voicedFrames === 0) {
    return '주기적인 음정이 전혀 잡히지 않았습니다. 이 스템에 베이스 대신 잔향이나 노이즈만 남았을 수 있습니다.';
  }
  if (s.droppedOutOfRange > s.rawNotes / 2) {
    return '검출된 음이 대부분 4현 베이스 음역 밖입니다. 다운튜닝이거나 옥타브 오검출입니다.';
  }
  if (s.droppedTooShort > s.rawNotes / 2) {
    return '검출된 음이 대부분 너무 짧습니다. 음이 끊겨 들리는 스템에서 흔한 증상입니다.';
  }
  return '음정은 잡혔는데 음표로 묶이지 않았습니다.';
}

/**
 * Say out loud the ways a result can be wrong while still looking finished.
 *
 * A tab with a confident-looking BPM and a full page of notes reads as trustworthy whether or
 * not the tempo was ever found, whether or not a third of the song went missing, and whether
 * or not the detector spent the choruses an octave up. Each of those is measured — none of
 * them was ever shown. That is the whole gap between "the transcription is bad" and knowing
 * which part of it to fix.
 */
function tabWarnings(result: NonNullable<StemPanelProps['tabResult']>): string[] {
  const s = result.stats;
  const out: string[] = [];

  if (s.tempoStrength < 0.35) {
    out.push(
      `온셋이 ${result.bpm.toFixed(1)} BPM 격자에 잘 안 물렸습니다 (강도 ${s.tempoStrength.toFixed(
        2,
      )}). 리듬은 믿지 마세요 — 아는 BPM이 있으면 위에 직접 넣는 게 훨씬 낫습니다.`,
    );
  }

  // Judge timing against the note value it has to land on, not against a fixed millisecond
  // count: 30ms is tight at 90 BPM and hopeless at 180.
  const sixteenthMs = 60000 / result.bpm / 4;
  const errorFraction = s.gridErrorMs / sixteenthMs;
  if (errorFraction > 0.2) {
    out.push(
      `온셋이 16분음표 간격의 ${(errorFraction * 100).toFixed(
        0,
      )}%만큼 격자에서 벗어나 있습니다. 템포가 흔들리는 연주이거나 박자가 반/두 배로 잡혔을 수 있습니다.`,
    );
  }

  if (s.largestGapMs > 8000) {
    out.push(
      `중간에 ${(s.largestGapMs / 1000).toFixed(
        0,
      )}초 동안 음표가 하나도 없습니다. 그 구간은 쉼표로 나오지만 실제로는 못 잡은 것일 수 있습니다.`,
    );
  } else if (s.coverage < 0.45) {
    out.push(
      `베이스가 나오는 구간의 ${(s.coverage * 100).toFixed(
        0,
      )}%에서만 음이 잡혔습니다. 스템을 htdemucs_ft로 다시 분리하면 나아지는 경우가 많습니다.`,
    );
  }

  if (s.octavesRepaired > 0) {
    out.push(`옥타브 오검출 ${s.octavesRepaired}개를 자동으로 내렸습니다.`);
  }

  if (s.subdivision === 3) {
    out.push(
      '박을 셋으로 나눈 셔플로 읽었습니다. 악보는 표준 관행대로 직선 8분음표로 적고 위에 셔플 표시를 넣었습니다 — 곧게 들린다면 BPM을 직접 넣어 다시 돌려보세요.',
    );
  }
  return out;
}

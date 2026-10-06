import { useMemo } from 'react';
import type { SyncAnchor } from '../lib/types';
import { normalizeAnchors, isUsable, tempoRatioAt, driftIfLinear } from '../lib/syncmap';

export interface SyncPanelProps {
  anchors: SyncAnchor[];
  currentTick: number;
  currentBarIndex: number;
  ticksPerQuarter: number;
  scoreBpm: number;
  hasAudio: boolean;

  /** Live follower telemetry (only meaningful outside anchor mode). */
  driftMs: number;
  driftAction: 'none' | 'nudge' | 'seek';

  /** Anchor mode drives the audio element on its own, decoupled from alphaTab. */
  anchorMode: boolean;
  audioPositionMs: number;
  audioDurationMs: number;
  audioPlaying: boolean;

  onToggleAnchorMode: () => void;
  onAudioPlayPause: () => void;
  onAudioSeek: (ms: number) => void;
  onAudioNudge: (deltaMs: number) => void;
  onCapture: () => void;
  onRemove: (anchor: SyncAnchor) => void;
  onClear: () => void;
  onSeekToAnchor: (a: SyncAnchor) => void;
}

export function SyncPanel(props: SyncPanelProps) {
  const normalized = useMemo(() => normalizeAnchors(props.anchors), [props.anchors]);
  const usable = isUsable(normalized);

  const ratio = useMemo(
    () => tempoRatioAt(normalized, props.currentTick, props.ticksPerQuarter, props.scoreBpm),
    [normalized, props.currentTick, props.ticksPerQuarter, props.scoreBpm],
  );

  const linearDrift = useMemo(
    () => driftIfLinear(normalized, props.currentTick),
    [normalized, props.currentTick],
  );

  return (
    <section className="panel sync-panel">
      <header className="panel-head">
        <h3>싱크</h3>
        <span className={`badge ${usable ? 'ok' : 'off'}`}>
          앵커 {normalized.length}개{usable ? '' : ' · 2개 필요'}
        </span>
      </header>

      {!props.hasAudio ? (
        <p className="hint">원본 음원을 불러오면 여기서 싱크를 맞춥니다.</p>
      ) : (
        <>
          {!usable && !props.anchorMode && (
            <p className="hint">
              앵커가 없어도 재생은 됩니다 — 지금은 탭 시간과 음원 시간을 1:1로 맞추고 있어서,
              곡이 1마디부터 바로 시작하면 대체로 맞습니다. 어긋나면 앵커를 찍어 바로잡으세요.
            </p>
          )}

          <button
            className={`btn wide toggle ${props.anchorMode ? 'on' : ''}`}
            onClick={props.onToggleAnchorMode}
          >
            {props.anchorMode ? '앵커 모드 끄기' : '앵커 모드'}
          </button>

          {props.anchorMode && (
            <div className="anchor-editor">
              <p className="hint">
                ① 탭에서 기준이 될 음표를 <strong>클릭</strong>해 커서를 옮기고 ② 아래에서 원본의
                같은 지점을 찾은 뒤 ③ 묶으세요.
              </p>

              <div className="anchor-target">
                탭 커서 <strong>{props.currentBarIndex + 1}마디</strong>
                <span className="dim tiny"> (tick {Math.round(props.currentTick)})</span>
              </div>

              <div className="audio-scrub">
                <button className="btn" onClick={props.onAudioPlayPause}>
                  {props.audioPlaying ? '❚❚' : '▶'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, props.audioDurationMs)}
                  step={1}
                  value={Math.min(props.audioPositionMs, props.audioDurationMs)}
                  onChange={(e) => props.onAudioSeek(Number(e.target.value))}
                />
                <span className="mono tiny">{(props.audioPositionMs / 1000).toFixed(3)}s</span>
              </div>

              <div className="nudge-row">
                {[-500, -100, -10, 10, 100, 500].map((d) => (
                  <button key={d} className="chip" onClick={() => props.onAudioNudge(d)}>
                    {d > 0 ? `+${d}` : d}
                  </button>
                ))}
                <span className="dim tiny">ms</span>
              </div>

              <button className="btn btn-primary wide" onClick={props.onCapture}>
                이 두 지점을 묶기
              </button>
            </div>
          )}

          {normalized.length > 0 && (
            <ul className="anchor-list">
              {normalized.map((a, i) => (
                <li key={`${a.synthTick}-${i}`}>
                  <button className="link" onClick={() => props.onSeekToAnchor(a)}>
                    {a.barIndex !== undefined ? `${a.barIndex + 1}마디` : `tick ${a.synthTick}`}
                    {a.barOccurence ? ` (${a.barOccurence + 1}회차)` : ''}
                  </button>
                  <span className="dim mono tiny">{(a.audioMs / 1000).toFixed(3)}s</span>
                  <button className="link danger" onClick={() => props.onRemove(a)} title="삭제">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {normalized.length > 0 && (
            <button className="btn tiny" onClick={props.onClear}>
              앵커 전체 삭제
            </button>
          )}

          {usable && !props.anchorMode && (
            <dl className="readout">
              <div>
                <dt>실시간 오차</dt>
                <dd className={Math.abs(props.driftMs) > 60 ? 'bad' : 'good'}>
                  {props.driftMs >= 0 ? '+' : ''}
                  {props.driftMs.toFixed(0)} ms
                  <span className="dim tiny"> · {labelAction(props.driftAction)}</span>
                </dd>
              </div>
              {ratio !== null && (
                <div>
                  <dt>음원 / 악보 템포</dt>
                  <dd>
                    {(ratio * 100).toFixed(2)}%
                    <span className="dim tiny"> ≈{(props.scoreBpm * ratio).toFixed(1)} BPM</span>
                  </dd>
                </div>
              )}
              {linearDrift !== null && (
                <div>
                  <dt>앵커 2개만 썼다면</dt>
                  <dd className={Math.abs(linearDrift) > 30 ? 'bad' : 'good'}>
                    {linearDrift >= 0 ? '+' : ''}
                    {linearDrift.toFixed(0)} ms 어긋남
                  </dd>
                </div>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

function labelAction(a: 'none' | 'nudge' | 'seek'): string {
  if (a === 'seek') return '점프 보정';
  if (a === 'nudge') return '미세 보정 중';
  return '안정';
}

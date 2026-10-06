import type { AlphaTabState } from '../hooks/useAlphaTab';

const SPEED_PRESETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

export interface TransportProps {
  state: AlphaTabState;
  speed: number;
  looping: boolean;
  metronome: boolean;
  countIn: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onSpeed: (v: number) => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onToggleCountIn: () => void;
}

export function Transport(props: TransportProps) {
  const { state, speed } = props;
  const disabled = !state.ready;

  return (
    <div className="transport">
      <div className="transport-row">
        <button
          className="btn btn-primary btn-play"
          onClick={props.onPlayPause}
          disabled={disabled}
          title="Space"
        >
          {state.playing ? '❚❚' : '▶'}
        </button>
        <button className="btn" onClick={props.onStop} disabled={disabled} title="처음으로">
          ■
        </button>

        <div className="time-readout">
          <span>{formatMs(state.position.currentTimeMs)}</span>
          <span className="dim"> / {formatMs(state.position.endTimeMs)}</span>
          <span className="dim bar-no">{state.currentBarIndex + 1}마디</span>
        </div>

        <div className="spacer" />

        <button
          className={`btn toggle ${props.looping ? 'on' : ''}`}
          onClick={props.onToggleLoop}
          disabled={disabled}
        >
          루프
        </button>
        <button
          className={`btn toggle ${props.metronome ? 'on' : ''}`}
          onClick={props.onToggleMetronome}
          disabled={disabled}
        >
          메트로놈
        </button>
        <button
          className={`btn toggle ${props.countIn ? 'on' : ''}`}
          onClick={props.onToggleCountIn}
          disabled={disabled}
        >
          카운트인
        </button>
      </div>

      <div className="transport-row speed-row">
        <label className="speed-label">
          속도 <strong>{Math.round(speed * 100)}%</strong>
        </label>
        <input
          type="range"
          min={0.25}
          max={1.25}
          step={0.01}
          value={speed}
          onChange={(e) => props.onSpeed(Number(e.target.value))}
          disabled={disabled}
          className="speed-slider"
        />
        <div className="speed-presets">
          {SPEED_PRESETS.map((s) => (
            <button
              key={s}
              className={`chip ${Math.abs(speed - s) < 0.005 ? 'on' : ''}`}
              onClick={() => props.onSpeed(s)}
              disabled={disabled}
            >
              {Math.round(s * 100)}
            </button>
          ))}
        </div>
      </div>

      {speed < 0.6 && (
        <p className="hint warn">
          0.6배 아래에서는 브라우저 내장 타임스트레치가 뭉개집니다. 신디 쪽은 멀쩡하니 이 구간은
          신디로 연습하시거나, signalsmith-stretch로 교체하세요.
        </p>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

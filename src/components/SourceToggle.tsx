import type { PlaybackSource } from '../lib/types';

interface SourceOption {
  id: PlaybackSource;
  label: string;
  hint: string;
}

const OPTIONS: SourceOption[] = [
  { id: 'synth', label: '신디', hint: '악보에서 생성된 베이스 — 음과 리듬 확인용' },
  { id: 'original', label: '원본', hint: '밴드 전체' },
  { id: 'bass', label: '베이스만', hint: '실제 연주자가 뭘 쳤는지 정확히 듣기' },
  { id: 'minusBass', label: '반주만', hint: '마이너스원 — 내가 그 자리를 채움' },
];

export interface SourceToggleProps {
  source: PlaybackSource;
  hasAudio: boolean;
  hasStems: boolean;
  onSource: (s: PlaybackSource) => void;
}

export function SourceToggle(props: SourceToggleProps) {
  /**
   * Sync anchors are deliberately NOT required here.
   *
   * Anchors align the recording with the *tab cursor*. They have nothing to do with whether
   * a recording can be played — and the stems are cut out of the original, so they are
   * sample-aligned with it by construction. Gating playback on anchors meant you could
   * finish a five-minute separation and still not be allowed to listen to the bass, which
   * is exactly backwards.
   *
   * Without anchors the cursor just follows alphaTab's own clock 1:1; the sync panel says so.
   */
  const disabledReason = (id: PlaybackSource): string | null => {
    if (id === 'synth') return null;
    if (!props.hasAudio) return '원본 음원을 먼저 불러오세요';
    if ((id === 'bass' || id === 'minusBass') && !props.hasStems) {
      return '스템 분리를 먼저 실행하세요';
    }
    return null;
  };

  return (
    <div className="source-toggle">
      <div className="segmented">
        {OPTIONS.map((o) => {
          const reason = disabledReason(o.id);
          return (
            <button
              key={o.id}
              className={props.source === o.id ? 'on' : ''}
              onClick={() => props.onSource(o.id)}
              disabled={reason !== null}
              title={reason ?? o.hint}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

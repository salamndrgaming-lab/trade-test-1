import type { TradingMode } from '@coin/shared';

export function ModeBadge({ mode, compact = false }: { mode: TradingMode; compact?: boolean }) {
  return (
    <span className={`mode-badge mode-${mode}`} title={mode === 'live' ? 'Real money: swaps are signed and sent' : 'Shadow: real quotes, nothing is signed or sent'}>
      <span className="dot" aria-hidden="true" />
      {mode === 'live' ? 'LIVE' : 'SHADOW'}
      {!compact && <span className="sub">{mode === 'live' ? 'real money' : 'no tx sent'}</span>}
    </span>
  );
}

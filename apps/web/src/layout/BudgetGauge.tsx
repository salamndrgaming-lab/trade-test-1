import type { StateSnapshot } from '@coin/shared';

const PROVIDER: Record<string, string> = { workers_ai: 'Workers AI', groq: 'Groq', gemini: 'Gemini', rules_only: 'Rules only' };

export function BudgetGauge({ ai, compact = false }: { ai: StateSnapshot['ai']; compact?: boolean }) {
  const pct = Math.min(1, ai.neuronsUsedToday / ai.neuronsDailyLimit);
  const level = ai.provider === 'rules_only' ? 'crit' : pct >= ai.switchAt ? 'warn' : 'ok';
  return (
    <div className={`gauge gauge-${level}${compact ? ' compact' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={ai.neuronsDailyLimit} aria-valuenow={ai.neuronsUsedToday} aria-label="AI budget, Workers AI neurons used today">
      <div className="gauge-head">
        <span className="label">AI budget</span>
        <span className="num">
          {ai.neuronsUsedToday.toLocaleString('en-US')}
          {!compact && <span className="muted"> / {ai.neuronsDailyLimit.toLocaleString('en-US')}</span>}
        </span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${pct * 100}%` }} />
        <div className="tick" style={{ left: `${ai.switchAt * 100}%` }} title="Switch to Groq at 90%" />
      </div>
      {!compact && (
        <div className="gauge-foot muted">
          {PROVIDER[ai.provider]}
          {ai.newTradesBlocked ? ' · no new trades' : ''}
        </div>
      )}
    </div>
  );
}

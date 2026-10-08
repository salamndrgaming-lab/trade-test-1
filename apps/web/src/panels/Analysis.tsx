import type { StateSnapshot, TokenAnalysis } from '@coin/shared';
import { CandleChart } from '../charts/CandleChart.js';
import { THRESHOLD_LABEL, fmtCompactUsd, fmtPrice, fmtThresholdValue } from '../data/format.js';

interface Props {
  state: StateSnapshot;
  token: TokenAnalysis | null;
  onSelect: (mint: string | null) => void;
  pinned: boolean;
}

export function Analysis({ state, token, onSelect, pinned }: Props) {
  const p = state.pipeline;
  const dropped = Object.values(p.droppedByStep).reduce((a, b) => a + b, 0);
  const tokens = [...(p.current && !p.recent.some((r) => r.mint === p.current!.mint) ? [p.current] : []), ...p.recent].slice(0, 12);
  return (
    <div className="analysis">
      <div className="an-stats">
        <div><span className="muted small">Scanned today</span><span className="num big">{p.scannedToday}</span></div>
        <div><span className="muted small">Dropped</span><span className="num big">{dropped}</span></div>
        <div><span className="muted small">Drop rate</span><span className="num big">{p.scannedToday ? Math.round((dropped / p.scannedToday) * 100) : 0}%</span></div>
      </div>

      <div className="an-chart-head">
        <h3>{state.pickChart ? `$${state.pickChart.symbol}` : 'Current pick'}</h3>
        {state.position && (
          <span className={`num ${state.position.pnlPct >= 0 ? 'pos' : 'neg'}`}>
            {state.position.pnlPct >= 0 ? '▲' : '▼'} {state.position.pnlPct.toFixed(1)}% · entry {fmtPrice(state.position.entryPriceUsd)}
            {state.position.shadow ? ' · sim' : ''}
          </span>
        )}
      </div>
      <CandleChart chart={state.pickChart} height={240} />

      <div className="an-picker">
        <div className="an-picker-head">
          <h3>Why it died</h3>
          {pinned && <button type="button" className="link-btn" onClick={() => onSelect(null)}>Follow live ↻</button>}
        </div>
        <div className="chips" role="listbox" aria-label="Recent tokens">
          {tokens.map((t) => (
            <button
              key={t.mint}
              type="button"
              role="option"
              aria-selected={token?.mint === t.mint}
              className={`chip v-${t.verdict}${token?.mint === t.mint ? ' sel' : ''}`}
              onClick={() => onSelect(t.mint)}
            >
              ${t.symbol}
              <span className="chip-sub">{t.diedAt ?? (t.verdict === 'pending' ? '…' : t.verdict.replace('_', ' '))}</span>
            </button>
          ))}
        </div>
      </div>

      {token && (
        <div className="checklist">
          <div className="cl-head">
            <strong>${token.symbol}</strong>
            <span className="muted small">{token.name} · mcap {fmtCompactUsd(token.metrics.mcapUsd)} · {token.metrics.holders ?? '—'} holders</span>
            <span className={`verdict v-${token.verdict}`}>{verdictText(token)}</span>
          </div>
          <ul>
            {token.checks.map((c) => (
              <li key={c.key} className={c.pass === null ? 'cl-skip' : c.pass ? 'cl-pass' : 'cl-drop'}>
                <span className="cl-tag">{c.pass === null ? 'SKIP' : c.pass ? 'PASS' : 'DROP'}</span>
                <span className="cl-key">{THRESHOLD_LABEL[c.key] ?? c.key}</span>
                <span className="cl-val num">{fmtThresholdValue(c.key, c.value)}</span>
                <span className="cl-lim num muted">{c.op === 'eq' ? '= yes' : `${c.op === 'min' ? '≥' : '≤'} ${fmtThresholdValue(c.key, c.limit)}`}</span>
              </li>
            ))}
          </ul>
          {token.momentum !== null && <p className="small muted">Scan momentum: <span className="num">{token.momentum.toFixed(2)}</span></p>}
        </div>
      )}
    </div>
  );
}

function verdictText(t: TokenAnalysis): string {
  switch (t.verdict) {
    case 'dropped': return `Died at ${t.diedAt}`;
    case 'picked': return 'Picked';
    case 'shortlisted': return 'Shortlisted';
    case 'passed_over': return 'Passed over';
    default: return 'In the chain…';
  }
}

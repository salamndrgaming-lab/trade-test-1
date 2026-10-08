import type { StateSnapshot, TokenAnalysis } from '@coin/shared';
import { THRESHOLD_LABEL, fmtThresholdValue } from '../data/format.js';
import { FilterChain } from './FilterChain.js';

/** Live thresholds with ✓/✗ against the selected token. */
export function Thresholds({ state, token }: { state: StateSnapshot; token: TokenAnalysis | null }) {
  const th = state.thresholds;
  const checkFor = (key: string) => token?.checks.find((c) => c.key === key);
  const mark = (key: string) => {
    const c = checkFor(key);
    if (!c || c.pass === null) return <span className="tm tm-skip" aria-label="not reached">·</span>;
    return c.pass ? <span className="tm tm-pass" aria-label="pass">✓</span> : <span className="tm tm-fail" aria-label="fail">✗</span>;
  };
  const val = (key: string) => {
    const c = checkFor(key);
    return c ? fmtThresholdValue(key, c.value) : '—';
  };

  return (
    <div className="thresholds">
      <h3>Filter chain</h3>
      <FilterChain state={state} token={token} />
      <p className="small muted">{token ? `Showing $${token.symbol}.` : 'No token selected.'} Order matters: the first failing step kills it.</p>

      <h3>Hard <span className="muted small">(arithmetic)</span></h3>
      <table className="th-table">
        <thead><tr><th>Rule</th><th>Limit</th><th>Token</th><th aria-label="result" /></tr></thead>
        <tbody>
          {th.hard.map((h) => (
            <tr key={h.key}>
              <td><code>{h.key}</code><span className="th-step">{h.step}</span></td>
              <td className="num">{h.op === 'min' ? '≥' : '≤'} {fmtThresholdValue(h.key, h.value)}</td>
              <td className="num">{val(h.key)}</td>
              <td>{mark(h.key)}</td>
            </tr>
          ))}
          {(['mint_revoked', 'freeze_revoked', 'sell_routes', 'buy_impact_pct', 'sell_impact_pct'] as const).map((k) => (
            <tr key={k}>
              <td><code>{k}</code><span className="th-step">chain_kill</span></td>
              <td className="num">{k.endsWith('_pct') ? `≤ ${th.maxPriceImpactPct}%` : '= yes'}</td>
              <td className="num">{val(k)}</td>
              <td>{mark(k)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Soft <span className="muted small">(model scores 0–1)</span></h3>
      <table className="th-table">
        <thead><tr><th>Score</th><th>Limit</th><th>Token</th><th aria-label="result" /></tr></thead>
        <tbody>
          {th.soft.map((s) => (
            <tr key={s.key}>
              <td><code>{s.key}</code><span className="th-step">{THRESHOLD_LABEL[s.key]}</span></td>
              <td className="num">{s.op} {s.value.toFixed(2)}</td>
              <td className="num">{val(s.key)}</td>
              <td>{mark(s.key)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

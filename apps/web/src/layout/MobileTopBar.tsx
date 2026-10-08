import type { StateSnapshot } from '@coin/shared';
import { fmtPct, fmtSignedUsd, fmtUsd } from '../data/format.js';
import { BudgetGauge } from './BudgetGauge.js';
import { Logo } from './Logo.js';
import { ModeBadge } from './ModeBadge.js';

export function MobileTopBar({ state, onSettings }: { state: StateSnapshot; onSettings: () => void }) {
  const up = state.wallet.pnlTodayUsd >= 0;
  return (
    <div className="m-topbar">
      <Logo size={24} />
      <ModeBadge mode={state.mode} compact />
      <div className="m-bal">
        <span className="num">{fmtUsd(state.wallet.usdBalance)}</span>
        <span className={`num small ${up ? 'pos' : 'neg'}`}>
          {up ? '▲' : '▼'} {fmtSignedUsd(state.wallet.pnlTodayUsd)} ({fmtPct(state.wallet.pnlTodayPct)})
        </span>
      </div>
      <BudgetGauge ai={state.ai} compact />
      <button type="button" className="icon-btn" onClick={onSettings} aria-label="Alert settings">
        <svg viewBox="0 0 16 16" width="18" height="18" shapeRendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M7 1h2v2h2v1h1v1h1v2h2v2h-2v2h-1v1h-1v1H9v2H7v-2H5v-1H4v-1H3V9H1V7h2V5h1V4h1V3h2zm0 4v1H6v4h1v1h2v-1h1V6H9V5z" /></svg>
      </button>
    </div>
  );
}

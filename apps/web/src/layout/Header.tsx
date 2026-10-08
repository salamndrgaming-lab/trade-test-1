import type { StateSnapshot } from '@coin/shared';
import { fmtDate, fmtUtcClock } from '../data/format.js';
import { useNow } from '../data/useMedia.js';
import { BudgetGauge } from './BudgetGauge.js';
import { KillSwitch } from './KillSwitch.js';
import { Logo } from './Logo.js';
import { ModeBadge } from './ModeBadge.js';

interface Props { state: StateSnapshot; onKill: (on: boolean) => void; onSettings: () => void; installSlot?: React.ReactNode }

export function Header({ state, onKill, onSettings, installSlot }: Props) {
  const now = useNow(1000);
  const day = Math.floor((now - state.startedAt) / 86_400_000) + 1;
  return (
    <header className="header">
      <div className="brand">
        <Logo size={40} />
        <div>
          <h1>Coin Trader <span className="brand-sub">Blob Desk</span></h1>
          <p className="tagline">Eight blobs. One wallet. Most coins don't make it.</p>
        </div>
      </div>
      <div className="clock">
        <span className="day">DAY {day}</span>
        <span className="muted">{fmtDate(now)}</span>
        <span className="utc">{fmtUtcClock(now)} <span className="muted">UTC</span></span>
      </div>
      <BudgetGauge ai={state.ai} />
      <div className="header-actions">
        <ModeBadge mode={state.mode} />
        {installSlot}
        <button type="button" className="icon-btn" onClick={onSettings} aria-label="Alert settings">
          <svg viewBox="0 0 16 16" width="18" height="18" shapeRendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M7 1h2v2h2v1h1v1h1v2h2v2h-2v2h-1v1h-1v1H9v2H7v-2H5v-1H4v-1H3V9H1V7h2V5h1V4h1V3h2zm0 4v1H6v4h1v1h2v-1h1V6H9V5z" /></svg>
        </button>
        <KillSwitch on={state.rails.killSwitch} onSet={onKill} className="header-kill" />
      </div>
    </header>
  );
}

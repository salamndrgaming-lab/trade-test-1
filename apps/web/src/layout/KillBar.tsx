import type { StateSnapshot } from '@coin/shared';
import { KillSwitch } from './KillSwitch.js';

/** Mobile: always-reachable bottom bar. */
export function KillBar({ state, onKill }: { state: StateSnapshot; onKill: (on: boolean) => void }) {
  const r = state.rails;
  return (
    <div className="m-killbar">
      <div className="m-kill-status">
        <span className={`pill ${r.buysAllowed ? 'pill-ok' : 'pill-bad'}`}>{r.buysAllowed ? '● Buys on' : '■ Buys off'}</span>
        {r.blockReason && <span className="muted small">{r.blockReason}</span>}
      </div>
      <KillSwitch on={r.killSwitch} onSet={onKill} className="m-kill-btn" />
    </div>
  );
}

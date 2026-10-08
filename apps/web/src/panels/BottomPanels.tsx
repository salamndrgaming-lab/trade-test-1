import { useState } from 'react';
import type { StateSnapshot } from '@coin/shared';
import { Analysis } from './Analysis.js';
import { Thresholds } from './Thresholds.js';

/** Side by side on desktop; tabs under 768px. */
export function BottomPanels({ state }: { state: StateSnapshot }) {
  const [tab, setTab] = useState<'analysis' | 'thresholds'>('analysis');
  const [pinned, setPinned] = useState<string | null>(null);
  const p = state.pipeline;
  const all = [...(p.current ? [p.current] : []), ...p.recent, ...p.shortlist];
  const token = (pinned && all.find((t) => t.mint === pinned)) || p.current || p.recent[0] || null;

  return (
    <section className="bottom" data-tab={tab}>
      <div className="tabs" role="tablist" aria-label="Analysis and thresholds">
        <button type="button" role="tab" aria-selected={tab === 'analysis'} onClick={() => setTab('analysis')}>Analysis</button>
        <button type="button" role="tab" aria-selected={tab === 'thresholds'} onClick={() => setTab('thresholds')}>Thresholds</button>
      </div>
      <div className="panel bp-analysis" role="tabpanel">
        <div className="panel-head"><h2>Analysis</h2></div>
        <Analysis state={state} token={token} onSelect={setPinned} pinned={!!pinned} />
      </div>
      <div className="panel bp-thresholds" role="tabpanel">
        <div className="panel-head"><h2>thresholds.ts</h2><span className="muted small">live</span></div>
        <Thresholds state={state} token={token} />
      </div>
    </section>
  );
}

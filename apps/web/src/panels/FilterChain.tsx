import type { KillStep, StateSnapshot, TokenAnalysis } from '@coin/shared';

/** The five steps in order; lights up the step where the selected token died. */
export function FilterChain({ state, token }: { state: StateSnapshot; token: TokenAnalysis | null }) {
  const chain = state.thresholds.chain;
  const died = token?.diedAt ?? null;
  const diedIdx = died ? chain.indexOf(died) : -1;
  const reached = (step: KillStep, i: number): 'pass' | 'dead' | 'todo' | 'pick' => {
    if (!token) return 'todo';
    if (died) return i < diedIdx ? 'pass' : i === diedIdx ? 'dead' : 'todo';
    if (step === 'pick') return token.verdict === 'picked' ? 'pick' : token.verdict === 'pending' || token.verdict === 'shortlisted' ? 'todo' : 'todo';
    const lastChecked = [...token.checks].reverse().find((c) => c.pass !== null);
    const lastIdx = lastChecked ? chain.indexOf(lastChecked.step) : -1;
    return i <= lastIdx ? 'pass' : 'todo';
  };
  return (
    <ol className="chain" aria-label="Filter chain">
      {chain.map((step, i) => {
        const r = reached(step, i);
        return (
          <li key={step} className={`chain-step cs-${r}`}>
            <span className="cs-name">{step}</span>
            <span className="cs-count num">{step === 'pick' ? '' : `−${state.pipeline.droppedByStep[step]}`}</span>
            <span className="cs-icon" aria-label={r}>{r === 'pass' ? '✓' : r === 'dead' ? '✗' : r === 'pick' ? '★' : '·'}</span>
          </li>
        );
      })}
    </ol>
  );
}

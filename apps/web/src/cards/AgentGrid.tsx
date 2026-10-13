import { useMemo, useState } from 'react';
import { AGENTS, AGENT_IDS, type AgentCard as Card, type AgentId, type StateSnapshot } from '@coin/shared';
import { blobPortrait } from '../office/sprites.js';

const STATUS_LABEL: Record<Card['status'], string> = { idle: 'idle', working: 'working', blocked: 'blocked', paused: 'paused' };

function AgentCard({ card, expanded, onToggle, now, portrait }: { card: Card; expanded: boolean; onToggle: () => void; now: number; portrait: string }) {
  const ago = Math.max(0, Math.round((now - card.quoteAt) / 1000));
  const bar = Math.max(0, Math.min(1, card.metric.bar));
  return (
    <button
      type="button"
      className={`agent-card status-${card.status}${expanded ? ' expanded' : ''}`}
      style={{ '--agent': AGENTS[card.id].color } as React.CSSProperties}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <div className="ac-top">
        <span className="ac-portrait" aria-hidden="true"><img src={portrait} alt="" /></span>
        <span className="ac-id">
          <span className="ac-name">{card.name}</span>
          <span className="ac-role">{card.role}</span>
        </span>
        <span className={`ac-status s-${card.status}`} title={STATUS_LABEL[card.status]}><i aria-hidden="true" /><span className="ac-status-text">{STATUS_LABEL[card.status]}</span></span>
      </div>
      <div className="ac-metric">
        <span className="ac-mlabel">{card.metric.label}</span>
        <span className="ac-mval num">{card.metric.display}</span>
      </div>
      <div className="ac-bar" aria-hidden="true">
        <div style={{ width: `${bar * 100}%` }} />
      </div>
      <div className={`ac-quote${card.quote ? '' : ' empty'}`}><span className="ac-q">{card.quote ? card.quote : 'Nothing to report yet.'}</span></div>
      {expanded && <div className="ac-more muted">{card.quote ? `Said ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`} ago` : 'Quiet so far'} · {AGENTS[card.id].role}</div>}
    </button>
  );
}

export function AgentGrid({ state }: { state: StateSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  const portraits = useMemo(() => Object.fromEntries(AGENT_IDS.map((id) => [id, blobPortrait(id, AGENTS[id].color)])) as Record<AgentId, string>, []);
  return (
    <section className="agent-grid" aria-label="Agents">
      {AGENT_IDS.map((id) => (
        <AgentCard key={id} card={state.agents[id]} now={state.serverTime} expanded={open === id} onToggle={() => setOpen(open === id ? null : id)} portrait={portraits[id]} />
      ))}
    </section>
  );
}

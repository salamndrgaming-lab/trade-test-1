import { useState } from 'react';
import { AGENTS, AGENT_IDS, type AgentCard as Card, type StateSnapshot } from '@coin/shared';

const STATUS_LABEL: Record<Card['status'], string> = { idle: 'idle', working: 'working', blocked: 'blocked', paused: 'paused' };

function AgentCard({ card, expanded, onToggle, now }: { card: Card; expanded: boolean; onToggle: () => void; now: number }) {
  const ago = Math.max(0, Math.round((now - card.quoteAt) / 1000));
  return (
    <button
      type="button"
      className={`agent-card status-${card.status}${expanded ? ' expanded' : ''}`}
      style={{ '--agent': AGENTS[card.id].color } as React.CSSProperties}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <div className="ac-head">
        <span className="ac-swatch" aria-hidden="true" />
        <span className="ac-name">{card.name}</span>
        <span className={`ac-status s-${card.status}`}>{STATUS_LABEL[card.status]}</span>
      </div>
      <div className="ac-role">{card.role}</div>
      <div className="ac-metric">
        <span className="ac-mlabel">{card.metric.label}</span>
        <span className="ac-mval num">{card.metric.display}</span>
      </div>
      <div className="ac-bar" aria-hidden="true">
        <div style={{ width: `${Math.max(0, Math.min(1, card.metric.bar)) * 100}%` }} />
      </div>
      <div className="ac-quote">“{card.quote}”</div>
      {expanded && <div className="ac-more muted">Said {ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`} ago · {AGENTS[card.id].role}</div>}
    </button>
  );
}

export function AgentGrid({ state }: { state: StateSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="agent-grid" aria-label="Agents">
      {AGENT_IDS.map((id) => (
        <AgentCard key={id} card={state.agents[id]} now={state.serverTime} expanded={open === id} onToggle={() => setOpen(open === id ? null : id)} />
      ))}
    </section>
  );
}

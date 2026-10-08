import { useEffect, useRef, useState } from 'react';
import { AGENTS, type AgentId, type StateSnapshot } from '@coin/shared';
import { OfficeScene } from './scene.js';

export function OfficeCanvas({ state }: { state: StateSnapshot }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [tapped, setTapped] = useState<{ id: AgentId; x: number; y: number } | null>(null);
  const [caption, setCaption] = useState<{ id: AgentId; text: string } | null>(null);

  useEffect(() => {
    const scene = new OfficeScene(canvasRef.current!);
    sceneRef.current = scene;
    scene.onSay = (id, text) => setCaption({ id, text });
    const ro = new ResizeObserver(([entry]) => entry && scene.resize(entry.contentRect.width));
    ro.observe(wrapRef.current!);
    // pause the animation loop when the tab is hidden to save battery
    const onVis = () => (document.visibilityState === 'visible' ? scene.start() : scene.stop());
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => {
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      scene.stop();
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    if (!tapped) return;
    const t = window.setTimeout(() => setTapped(null), 4000);
    return () => window.clearTimeout(t);
  }, [tapped]);

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const id = scene.hitTest(e.clientX, e.clientY);
    if (!id) return setTapped(null);
    const p = scene.agentCss(id);
    setTapped({ id, ...p });
  };

  const tappedCard = tapped ? state.agents[tapped.id] : null;

  return (
    <section className="panel office" aria-label="Trading desk office">
      <div className="panel-head">
        <h2>The desk</h2>
        <span className="muted small">Tap a blob to hear it</span>
      </div>
      <div className="office-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="office-canvas" onPointerUp={onPointer} role="img" aria-label="Animated pixel office: agents walk each token from desk to desk" />
        {tapped && tappedCard && (
          <div className="office-pop" style={{ left: tapped.x, top: tapped.y, '--agent': AGENTS[tapped.id].color } as React.CSSProperties} role="status">
            <strong>{tappedCard.name}</strong>
            <span>“{tappedCard.quote}”</span>
          </div>
        )}
      </div>
      <div className="office-caption" aria-live="polite">
        {caption ? (
          <>
            <span className="cap-name" style={{ color: AGENTS[caption.id].color }}>{AGENTS[caption.id].name}:</span> {caption.text}
          </>
        ) : (
          <span className="muted">Waiting for the next token…</span>
        )}
      </div>
    </section>
  );
}

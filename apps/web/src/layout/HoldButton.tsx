import { useEffect, useRef, useState } from 'react';

interface Props {
  holdMs?: number;
  onConfirm: () => void;
  label: string;
  armedLabel?: string;
  variant?: 'danger' | 'calm';
  className?: string;
}

/** Press and hold to confirm. A stray tap does nothing. Keyboard: hold Space or Enter. */
export function HoldButton({ holdMs = 2000, onConfirm, label, armedLabel = 'Keep holding…', variant = 'danger', className = '' }: Props) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef(0);
  const done = useRef(false);

  const stop = () => {
    start.current = null;
    cancelAnimationFrame(raf.current);
    setProgress(0);
  };

  const begin = () => {
    if (start.current !== null) return;
    done.current = false;
    start.current = performance.now();
    navigator.vibrate?.(10);
    const step = () => {
      if (start.current === null) return;
      const p = Math.min(1, (performance.now() - start.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        if (!done.current) {
          done.current = true;
          navigator.vibrate?.([30, 40, 30]);
          onConfirm();
        }
        stop();
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      type="button"
      className={`hold-btn hold-${variant} ${className}`}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); begin(); }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin(); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') stop(); }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={`${label} (press and hold for ${holdMs / 1000} seconds)`}
    >
      <span className="hold-fill" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      <span className="hold-text">{progress > 0 ? armedLabel : label}</span>
    </button>
  );
}

/** Original pixel mark: a coin with a blob face. */
export function Logo({ size = 36 }: { size?: number }) {
  const px = ['..pppp..', '.pyyyyp.', 'pyyyyyyp', 'pywyywyp', 'pykyykyp', 'pyyyyyyp', '.pykkyp.', '..pppp..'];
  const col: Record<string, string> = { p: 'var(--pink)', y: '#ffd23f', w: '#ffffff', k: '#1a1426' };
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true" className="logo">
      {px.flatMap((row, y) => [...row].map((c, x) => (c in col ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={col[c]} /> : null)))}
    </svg>
  );
}

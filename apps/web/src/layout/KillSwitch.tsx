import { HoldButton } from './HoldButton.js';

export function KillSwitch({ on, onSet, className = '' }: { on: boolean; onSet: (on: boolean) => void; className?: string }) {
  return on ? (
    <HoldButton className={className} variant="calm" label="Kill switch ON · hold to release" armedLabel="Releasing…" onConfirm={() => onSet(false)} />
  ) : (
    <HoldButton className={className} variant="danger" label="Kill switch · hold 2s" armedLabel="Selling & freezing…" onConfirm={() => onSet(true)} />
  );
}

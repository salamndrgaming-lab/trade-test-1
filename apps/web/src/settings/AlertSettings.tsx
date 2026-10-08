import { useEffect, useRef, useState } from 'react';

export const ALERT_TYPES = [
  { id: 'buy_filled', label: 'Buy filled' },
  { id: 'sell_filled', label: 'Sell filled' },
  { id: 'stop_loss', label: 'Stop-loss hit' },
  { id: 'loss_cap', label: 'Daily loss cap hit' },
  { id: 'kill_switch', label: 'Kill switch used' },
  { id: 'bot_offline', label: 'Bot offline > 5 min' },
  { id: 'ai_budget', label: 'AI budget at 90%' },
] as const;
export type AlertId = (typeof ALERT_TYPES)[number]['id'];

const KEY = 'coin-trader.alerts';

export function loadAlertPrefs(): Record<AlertId, boolean> {
  const defaults = Object.fromEntries(ALERT_TYPES.map((a) => [a.id, true])) as Record<AlertId, boolean>;
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function AlertSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [prefs, setPrefs] = useState(loadAlertPrefs);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => ('Notification' in window ? Notification.permission : 'unsupported'));

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const toggle = (id: AlertId) => {
    const next = { ...prefs, [id]: !prefs[id] };
    setPrefs(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };

  const enable = async () => {
    if (!('Notification' in window)) return;
    const p = await Notification.requestPermission();
    setPerm(p);
  };

  const test = async () => {
    const reg = await navigator.serviceWorker?.ready;
    await reg?.showNotification('Coin Trader', { body: 'Test alert: notifications work on this device.', icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: 'test' });
  };

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2>Alerts</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {isIos() && !isStandalone() && (
          <p className="note">On iPhone, push alerts only work after you add the app to your home screen: Share → Add to Home Screen.</p>
        )}
        <div className="perm-row">
          <span>Notifications: <strong>{perm}</strong></span>
          {perm === 'default' && <button type="button" className="btn" onClick={enable}>Enable</button>}
          {perm === 'granted' && <button type="button" className="btn" onClick={test}>Send test</button>}
        </div>
        <ul className="toggles">
          {ALERT_TYPES.map((a) => (
            <li key={a.id}>
              <label>
                <span>{a.label}</span>
                <input type="checkbox" role="switch" checked={prefs[a.id]} onChange={() => toggle(a.id)} />
              </label>
            </li>
          ))}
        </ul>
        <p className="small muted">The bot sends these over Web Push once it's running on the server (phase 4). Your choices are saved on this device.</p>
      </div>
    </dialog>
  );
}

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

/** Android/desktop Chrome install prompt. iOS uses Share → Add to Home Screen (hint lives in Alerts). */
export function InstallButton() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setEvt(e as BeforeInstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', on);
    const done = () => setEvt(null);
    window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('beforeinstallprompt', on); window.removeEventListener('appinstalled', done); };
  }, []);
  if (!evt) return null;
  return (
    <button type="button" className="btn install-btn" onClick={async () => { await evt.prompt(); setEvt(null); }}>
      Install app
    </button>
  );
}

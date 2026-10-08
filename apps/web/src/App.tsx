import { useState } from 'react';
import { AgentGrid } from './cards/AgentGrid.js';
import { BalanceChart } from './charts/BalanceChart.js';
import { useStateFeed } from './data/useStateFeed.js';
import { Header } from './layout/Header.js';
import { InstallButton } from './layout/InstallButton.js';
import { KillBar } from './layout/KillBar.js';
import { MobileTopBar } from './layout/MobileTopBar.js';
import { OfficeCanvas } from './office/OfficeCanvas.js';
import { BottomPanels } from './panels/BottomPanels.js';
import { AlertSettings } from './settings/AlertSettings.js';

export function App() {
  const feed = useStateFeed();
  const [settings, setSettings] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const s = feed.state;

  const onKill = (on: boolean) => {
    setKillError(null);
    feed.setKillSwitch(on).catch((e: unknown) => setKillError(e instanceof Error ? e.message : String(e)));
  };

  if (!s) {
    return (
      <div className="frame">
        <div className="boot">{feed.error ? `Can't reach the desk: ${feed.error}` : 'Opening the desk…'}</div>
      </div>
    );
  }

  const stale = feed.lastOkAt !== null && feed.error !== null;

  return (
    <div className={`frame${s.rails.killSwitch ? ' killed' : ''}`}>
      <Header state={s} onKill={onKill} onSettings={() => setSettings(true)} installSlot={<InstallButton />} />
      <MobileTopBar state={s} onSettings={() => setSettings(true)} />

      {(stale || killError || s.source === 'mock') && (
        <div className="banners">
          {s.source === 'mock' && <div className="banner banner-info">Demo data: the mock desk runs in your browser. No bot is connected.</div>}
          {stale && <div className="banner banner-warn">Lost the bot ({feed.error}). Showing the last snapshot.</div>}
          {killError && <div className="banner banner-bad">{killError}</div>}
        </div>
      )}

      <main className="main">
        <AgentGrid state={s} />
        <OfficeCanvas state={s} />
        <BalanceChart state={s} />
        <BottomPanels state={s} />
      </main>

      <footer className="footer small muted">
        <span>Coin Trader · Blob Desk · {s.mode === 'shadow' ? 'shadow mode: nothing is signed or sent' : 'LIVE mode'}</span>
        <span>
          Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts™
        </span>
      </footer>

      <KillBar state={s} onKill={onKill} />
      <AlertSettings open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

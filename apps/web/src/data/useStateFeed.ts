import type { StateSnapshot } from '@coin/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The dashboard's one data source.
 * - VITE_STATE_URL set: poll the bot (2 s while visible, 30 s in the background).
 * - unset in `vite dev`: the in-browser dev desk (fake data). The dynamic import sits behind
 *   `import.meta.env.DEV`, so production builds drop it and `check:no-mock` proves it.
 * - unset in a production build: unconfigured ("Not connected to a bot").
 */

const STATE_URL = import.meta.env.VITE_STATE_URL?.trim() || (import.meta.env.DEV ? '' : null);
const VISIBLE_MS = 2000;
const HIDDEN_MS = 30_000;

export interface StateFeed {
  state: StateSnapshot | null;
  error: string | null;
  lastOkAt: number | null;
  unconfigured: boolean;
  setKillSwitch: (on: boolean) => Promise<void>;
}

interface Desk { tick(now?: number): StateSnapshot; setKillSwitch(on: boolean, now?: number): StateSnapshot }

export function useStateFeed(): StateFeed {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const desk = useRef<Desk | null>(null);
  const unconfigured = STATE_URL === null;

  useEffect(() => {
    if (unconfigured) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | null = null;

    const poll = async () => {
      clearTimeout(timer);
      try {
        let snap: StateSnapshot;
        if (STATE_URL) {
          ctrl = new AbortController();
          const kill = setTimeout(() => ctrl?.abort(), 8000);
          const res = await fetch(STATE_URL, { cache: 'no-store', credentials: 'include', signal: ctrl.signal }).finally(() => clearTimeout(kill));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          snap = (await res.json()) as StateSnapshot;
        } else {
          if (import.meta.env.DEV && !desk.current) {
            const { MockDesk } = await import('@coin/shared/mock');
            desk.current = new MockDesk();
          }
          if (!desk.current) throw new Error('no data source');
          snap = desk.current.tick();
        }
        if (stop) return;
        setState(snap);
        setError(null);
        setLastOkAt(Date.now());
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e));
      }
      if (!stop) timer = setTimeout(poll, document.hidden ? HIDDEN_MS : VISIBLE_MS);
    };

    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [unconfigured]);

  const setKillSwitch = useCallback(async (on: boolean) => {
    if (desk.current) {
      setState(desk.current.setKillSwitch(on));
      return;
    }
    // the bot's write endpoints (behind the Access JWT check) arrive in phase 4
    throw new Error('The kill switch endpoint arrives in phase 4. Nothing is traded yet (shadow mode).');
  }, []);

  return { state, error, lastOkAt, unconfigured, setKillSwitch };
}

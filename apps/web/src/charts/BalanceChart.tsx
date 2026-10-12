import { useEffect, useRef } from 'react';
import { AreaSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { StateSnapshot } from '@coin/shared';
import { fmtSignedUsd, fmtUsd } from '../data/format.js';
import { CHART_COLORS, baseOptions } from './theme.js';

export function BalanceChart({ state }: { state: StateSnapshot }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<{ chart: IChartApi; eq: ISeriesApi<'Area'>; vol: ISeriesApi<'Histogram'>; fitted: boolean } | null>(null);

  useEffect(() => {
    const c = createChart(el.current!, { ...baseOptions(), timeScale: { ...baseOptions().timeScale, secondsVisible: false } });
    const eq = c.addSeries(AreaSeries, {
      lineColor: CHART_COLORS.line, lineWidth: 2, topColor: 'rgba(46,230,200,0.22)', bottomColor: 'rgba(46,230,200,0.0)',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const vol = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
    c.panes()[1]?.setHeight(48);
    api.current = { chart: c, eq, vol, fitted: false };
    return () => { c.remove(); api.current = null; };
  }, []);

  const points = state.equity.points;
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.eq.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.usd })));
    a.vol.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.volumeUsd, color: p.up ? 'rgba(61,220,132,0.7)' : 'rgba(255,84,104,0.7)' })));
    if (!a.fitted && points.length) { a.chart.timeScale().fitContent(); a.fitted = true; }
  }, [points]);

  const w = state.wallet;
  return (
    <section className="panel balance" aria-label="Balance">
      <div className="panel-head">
        <h2>Balance</h2>
        <div className="bal-label">
          <span className="num big">{fmtUsd(w.usdBalance)}</span>
          <span className="num muted">{w.solBalance.toFixed(3)} SOL</span>
          <span className={`num ${w.pnlTodayUsd >= 0 ? 'pos' : 'neg'}`}>{w.pnlTodayUsd >= 0 ? '▲' : '▼'} {fmtSignedUsd(w.pnlTodayUsd)} today</span>
        </div>
      </div>
      <div className="legend small muted">
        <span><i className="sw sw-line" /> Equity (USD)</span>
        <span><i className="sw sw-up" /> Traded volume, balance up</span>
        <span><i className="sw sw-down" /> Traded volume, balance down</span>
      </div>
      <div className="chart-box" style={{ height: 220 }}>
        <div ref={el} className="chart-el" />
        {points.length === 0 && <div className="chart-empty muted">No balance history yet. Set BOT_WALLET_PUBKEY on the bot to track the wallet.</div>}
      </div>
    </section>
  );
}

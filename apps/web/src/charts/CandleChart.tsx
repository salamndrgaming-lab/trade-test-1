import { useEffect, useRef } from 'react';
import { CandlestickSeries, HistogramSeries, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { StateSnapshot } from '@coin/shared';
import { CHART_COLORS, baseOptions, pricePrecision } from './theme.js';

type PickChart = NonNullable<StateSnapshot['pickChart']>;

/** Candles for the current pick with buy/sell markers; volume in its own pane (no second axis on the price pane). */
export function CandleChart({ chart, height = 260 }: { chart: PickChart | null; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<{ chart: IChartApi; candles: ISeriesApi<'Candlestick'>; vol: ISeriesApi<'Histogram'>; markers: ISeriesMarkersPluginApi<Time>; mint: string | null } | null>(null);

  useEffect(() => {
    const c = createChart(el.current!, baseOptions());
    const candles = c.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, borderVisible: false,
      wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down,
    });
    const vol = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
    c.panes()[1]?.setHeight(56);
    const markers = createSeriesMarkers(candles, []);
    api.current = { chart: c, candles, vol, markers, mint: null };
    return () => { c.remove(); api.current = null; };
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    if (!chart) {
      a.candles.setData([]);
      a.vol.setData([]);
      a.markers.setMarkers([]);
      a.mint = null;
      return;
    }
    const last = chart.candles.at(-1);
    if (last) a.candles.applyOptions({ priceFormat: { type: 'price', ...pricePrecision(last.close) } });
    a.candles.setData(chart.candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    a.vol.setData(chart.candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? 'rgba(61,220,132,0.55)' : 'rgba(255,84,104,0.55)' })));
    a.markers.setMarkers(
      chart.markers.map((m) => ({
        time: m.time as UTCTimestamp,
        position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: m.side === 'buy' ? CHART_COLORS.line : CHART_COLORS.pink,
        text: (m.side === 'buy' ? 'BUY' : 'SELL') + (m.shadow ? ' (sim)' : ''),
      })),
    );
    if (a.mint !== chart.mint) {
      a.chart.timeScale().fitContent();
      a.mint = chart.mint;
    }
  }, [chart]);

  return (
    <div className="chart-box" style={{ height }}>
      <div ref={el} className="chart-el" />
      {!chart && <div className="chart-empty muted">No pick yet. The chart appears when Chief picks a token.</div>}
    </div>
  );
}

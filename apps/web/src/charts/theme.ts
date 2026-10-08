import { ColorType, type DeepPartial, type ChartOptions } from 'lightweight-charts';

export const CHART_COLORS = {
  surface: '#16131f',
  text: '#b4abc9',
  grid: '#221d30',
  border: '#2c2640',
  up: '#3ddc84',
  down: '#ff5468',
  line: '#2ee6c8',
  pink: '#ff3e9a',
};

export function baseOptions(): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: CHART_COLORS.surface },
      textColor: CHART_COLORS.text,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11,
      attributionLogo: true,
      panes: { separatorColor: CHART_COLORS.border, separatorHoverColor: CHART_COLORS.border, enableResize: false },
    },
    grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
    rightPriceScale: { borderColor: CHART_COLORS.border },
    timeScale: { borderColor: CHART_COLORS.border, timeVisible: true, secondsVisible: false },
    crosshair: { vertLine: { color: '#5b5275', labelBackgroundColor: '#2c2640' }, horzLine: { color: '#5b5275', labelBackgroundColor: '#2c2640' } },
    // let the page scroll vertically on touch; horizontal drag pans the chart
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  };
}

export function pricePrecision(p: number): { precision: number; minMove: number } {
  if (!(p > 0)) return { precision: 2, minMove: 0.01 };
  const precision = Math.min(12, Math.max(2, -Math.floor(Math.log10(p)) + 3));
  return { precision, minMove: 10 ** -precision };
}

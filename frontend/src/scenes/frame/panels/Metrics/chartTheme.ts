import type { MetricSeries } from './metricsLogic'

export type MetricChartThemeName = 'light' | 'dark'

export interface MetricChartTheme {
  name: MetricChartThemeName
  background: string
  grid: string
  axis: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipText: string
  tooltipMutedText: string
  tooltipShadow: string
  brushAccent: string
  brushSelectionStroke: string
  brushHandleFill: string
  brushHandleStroke: string
  seriesColors: Record<string, string>
}

const lightSeriesColors: Record<string, string> = {
  '#2dd4bf': '#0f766e',
  '#f59e0b': '#b45309',
  '#38bdf8': '#0369a1',
  '#a78bfa': '#6d28d9',
  '#34d399': '#047857',
  '#fb7185': '#be123c',
  '#f472b6': '#be185d',
}

export const metricChartThemes: Record<MetricChartThemeName, MetricChartTheme> = {
  light: {
    name: 'light',
    background: 'rgba(255,255,255,0.76)',
    grid: 'rgba(100,116,139,0.16)',
    axis: 'rgba(51,65,85,0.72)',
    tooltipBackground: 'rgba(255,255,255,0.98)',
    tooltipBorder: 'rgba(100,116,139,0.24)',
    tooltipText: 'rgba(15,23,42,0.92)',
    tooltipMutedText: 'rgba(71,85,105,0.72)',
    tooltipShadow: 'rgba(100,116,139,0.18)',
    brushAccent: '#4a4b8c',
    brushSelectionStroke: 'rgba(74,75,140,0.72)',
    brushHandleFill: '#ffffff',
    brushHandleStroke: '#64748b',
    seriesColors: lightSeriesColors,
  },
  dark: {
    name: 'dark',
    background: '#18181b',
    grid: 'rgba(244,244,245,0.1)',
    axis: 'rgba(244,244,245,0.78)',
    tooltipBackground: 'rgba(24,24,27,0.96)',
    tooltipBorder: 'rgba(244,244,245,0.24)',
    tooltipText: 'rgba(244,244,245,0.92)',
    tooltipMutedText: 'rgba(244,244,245,0.62)',
    tooltipShadow: 'rgba(0,0,0,0.24)',
    brushAccent: '#f6acc8',
    brushSelectionStroke: '#ffffff',
    brushHandleFill: '#f2f2f2',
    brushHandleStroke: '#999999',
    seriesColors: {},
  },
}

export function themeMetricSeries(series: MetricSeries[], chartTheme: MetricChartTheme): MetricSeries[] {
  if (chartTheme.name === 'dark') {
    return series
  }

  return series.map((chartSeries) => ({
    ...chartSeries,
    color: chartTheme.seriesColors[chartSeries.color.toLowerCase()] ?? chartSeries.color,
  }))
}

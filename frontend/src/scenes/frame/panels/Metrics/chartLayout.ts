/**
 * The metric card chart's geometry, shared between the component that draws
 * it (BrushChart) and the logic that decides how many points to draw for
 * it (metricsLogic: the plot width in pixels sets the point budget).
 */
export const metricChartHeight = 200
export const metricChartMargin = { top: 20, left: 56, bottom: 12, right: 45 }
export const brushChartMargin = { top: 10, bottom: 15, left: 50, right: 20 }

/** The x extent of the main plot for a card `width` px wide. */
export function metricChartPlotWidth(width: number): number {
  return Math.max(width - metricChartMargin.left - metricChartMargin.right, 0)
}

/** The x extent of the overview (brush) plot for a card `width` px wide. */
export function brushChartPlotWidth(width: number): number {
  return Math.max(width - brushChartMargin.left - brushChartMargin.right, 0)
}

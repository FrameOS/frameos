// @vitest-environment jsdom
//
// The metric card chart with a long history behind it: the SVG it emits
// must be sized by the plot's pixel width, not by the sample count. Rendered
// from auth-web across the package boundary like the other shared-spa
// tests (frontend/ has no test runner).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrushChart } from "../../../../../../frontend/src/scenes/frame/panels/Metrics/BrushChart";
import {
  prepareChartSeriesList,
  type ChartSeries,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/chartData";
import {
  brushChartPlotWidth,
  metricChartHeight,
  metricChartMargin,
  metricChartPlotWidth,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/chartLayout";
import { metricChartThemes } from "../../../../../../frontend/src/scenes/frame/panels/Metrics/chartTheme";
import type {
  MetricPoint,
  MetricSeries,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/metricsLogic";

const start = Date.parse("2026-08-01T00:00:00Z");
const MINUTE = 60 * 1000;
const WIDTH = 900;

function points(count: number, intervalMs = MINUTE): MetricPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    x: new Date(start + index * intervalMs),
    y: 50 + Math.round(Math.sin(index / 90) * 30),
  }));
}

function history(count: number): MetricSeries[] {
  return [{ key: "batteryPercent", label: "Battery", color: "#123456", axis: "left", unit: "percent", data: points(count) }];
}

function prepared(
  series: MetricSeries[],
  timeRange: { start: number; end: number } | null,
): { visible: ChartSeries[]; overview: ChartSeries[] } {
  return {
    visible: prepareChartSeriesList(series, {
      timeRange,
      pixelWidth: metricChartPlotWidth(WIDTH),
      gapThresholdMs: 20 * MINUTE,
    }),
    overview: prepareChartSeriesList(series, {
      timeRange: null,
      pixelWidth: brushChartPlotWidth(WIDTH),
      gapThresholdMs: 20 * MINUTE,
      pointsPerPixel: 1,
    }),
  };
}

function renderChart(
  series: MetricSeries[],
  visibleTimeRange: { start: number; end: number },
  onTimeRangeChange = () => {},
) {
  const total = { start, end: start + (series[0]?.data.length ?? 1) * MINUTE };
  const { visible, overview } = prepared(series, visibleTimeRange);
  return render(
    <BrushChart
      width={WIDTH}
      height={metricChartHeight}
      margin={metricChartMargin}
      series={visible}
      overviewSeries={overview}
      totalTimeRange={total}
      visibleTimeRange={visibleTimeRange}
      gapThresholdMs={20 * MINUTE}
      onTimeRangeChange={onTimeRangeChange}
      onResetTimeRange={() => {}}
      chartTheme={metricChartThemes.dark}
    />,
  );
}

afterEach(cleanup);

describe("BrushChart with a long history", () => {
  it("draws a month of minute samples zoomed all the way out without a node per sample", () => {
    const series = history(30 * 24 * 60);
    const { container } = renderChart(series, { start, end: start + 30 * 24 * 60 * MINUTE });

    // Two plots (main + overview), each one area and one line for a single series.
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(4);
    expect(paths.length).toBeLessThan(40);
    // No sample circles at this density.
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    // And the curve segments are bounded by the plot width (two points per
    // pixel; the closed area traces the curve out and back, so twice that),
    // not by the 43 200 samples.
    const mostCurves = Math.max(
      ...Array.from(paths).map((path) => (path.getAttribute("d") ?? "").match(/C/g)?.length ?? 0),
    );
    expect(mostCurves).toBeGreaterThan(metricChartPlotWidth(WIDTH));
    expect(mostCurves).toBeLessThanOrEqual(4 * metricChartPlotWidth(WIDTH));
  });

  it("draws sample circles again once the window is narrow enough to see them", () => {
    const series = history(30 * 24 * 60);
    const { container } = renderChart(series, { start: start + 1000 * MINUTE, end: start + 1060 * MINUTE });
    // 61 samples inside + 2 padding, well under a quarter of the plot width.
    expect(container.querySelectorAll("circle").length).toBe(63);
  });

  it("clips the padding samples so the line runs off the plot instead of over the axis", () => {
    const series = history(500);
    const { container } = renderChart(series, { start: start + 100 * MINUTE, end: start + 200 * MINUTE });
    const clipped = container.querySelectorAll("g[clip-path]");
    expect(clipped.length).toBe(2);
    clipped.forEach((group) => {
      const id = group.getAttribute("clip-path")?.match(/url\(#(.+)\)/)?.[1];
      expect(id).toBeTruthy();
      expect(container.querySelector(`clipPath[id="${id}"] rect`)).not.toBeNull();
    });
  });

  it("shows a tooltip for the sample under the pointer", () => {
    const series = history(500);
    const { container } = renderChart(series, { start: start + 100 * MINUTE, end: start + 200 * MINUTE });
    const overlay = container.querySelector('rect[style*="crosshair"]');
    expect(overlay).not.toBeNull();
    act(() => {
      fireEvent.pointerMove(overlay!, { clientX: 10, clientY: 10 });
    });
    expect(container.textContent).toContain("Battery");
    expect(container.textContent).toMatch(/\d+%/);
    act(() => {
      fireEvent.pointerLeave(overlay!);
    });
    expect(container.textContent).not.toContain("Battery");
  });

  it("renders nothing to draw when every series is hidden", () => {
    const { container } = render(
      <BrushChart
        width={WIDTH}
        height={metricChartHeight}
        margin={metricChartMargin}
        series={[]}
        overviewSeries={[]}
        totalTimeRange={{ start, end: start + 100 * MINUTE }}
        visibleTimeRange={{ start, end: start + 100 * MINUTE }}
        gapThresholdMs={20 * MINUTE}
        onTimeRangeChange={() => {}}
        onResetTimeRange={() => {}}
        chartTheme={metricChartThemes.light}
      />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("path").length).toBeLessThan(10);
  });
});

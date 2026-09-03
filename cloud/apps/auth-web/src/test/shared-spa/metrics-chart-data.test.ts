// The Metrics panel draws each card at a point budget set by its pixel
// width: the visible window is binary-searched out of the history, cut at
// sampling gaps, then thinned with largest-triangle-three-buckets. Pure
// functions, tested from auth-web like the other shared-SPA logic
// (frontend/ has no test runner).
import { describe, expect, it } from "vitest";
import {
  flattenChartSeries,
  largestTriangleThreeBuckets,
  lowerBoundByTime,
  prepareChartSeries,
  prepareChartSeriesByCategory,
  sliceByTimeRange,
  splitByGap,
  upperBoundByTime,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/chartData";
import {
  brushChartPlotWidth,
  metricChartPlotWidth,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/chartLayout";
import type {
  MetricPoint,
  MetricSeries,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/metricsLogic";

const start = Date.parse("2026-09-01T00:00:00Z");
const MINUTE = 60 * 1000;

function points(
  count: number,
  value: (index: number) => number = (index) => index,
  intervalMs = MINUTE,
): MetricPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    x: new Date(start + index * intervalMs),
    y: value(index),
  }));
}

function series(data: MetricPoint[], overrides: Partial<MetricSeries> = {}): MetricSeries {
  return { key: "k", label: "k", color: "c", axis: "left", data, ...overrides };
}

function isSorted(data: MetricPoint[]): boolean {
  return data.every((point, index) => index === 0 || point.x.getTime() >= data[index - 1].x.getTime());
}

describe("binary search bounds", () => {
  const data = points(10);

  it("finds the first point at or after a time", () => {
    expect(lowerBoundByTime(data, start)).toBe(0);
    expect(lowerBoundByTime(data, start + 3 * MINUTE)).toBe(3);
    expect(lowerBoundByTime(data, start + 3 * MINUTE + 1)).toBe(4);
    expect(lowerBoundByTime(data, start - 1)).toBe(0);
    expect(lowerBoundByTime(data, start + 100 * MINUTE)).toBe(10);
  });

  it("finds the first point after a time", () => {
    expect(upperBoundByTime(data, start + 3 * MINUTE)).toBe(4);
    expect(upperBoundByTime(data, start + 3 * MINUTE - 1)).toBe(3);
    expect(upperBoundByTime(data, start - 1)).toBe(0);
    expect(upperBoundByTime(data, start + 9 * MINUTE)).toBe(10);
  });

  it("copes with empty data", () => {
    expect(lowerBoundByTime([], start)).toBe(0);
    expect(upperBoundByTime([], start)).toBe(0);
  });
});

describe("sliceByTimeRange", () => {
  const data = points(100);

  it("returns the window plus one neighbour on each side", () => {
    const { points: sliced, insideCount } = sliceByTimeRange(data, {
      start: start + 10 * MINUTE,
      end: start + 20 * MINUTE,
    });
    expect(insideCount).toBe(11);
    expect(sliced).toHaveLength(13);
    expect(sliced[0]).toBe(data[9]);
    expect(sliced[sliced.length - 1]).toBe(data[21]);
  });

  it("does not pad past the ends of the data", () => {
    const { points: head } = sliceByTimeRange(data, { start: start - MINUTE, end: start + 2 * MINUTE });
    expect(head[0]).toBe(data[0]);
    expect(head).toHaveLength(4);
    const { points: tail } = sliceByTimeRange(data, { start: start + 98 * MINUTE, end: start + 500 * MINUTE });
    expect(tail[tail.length - 1]).toBe(data[99]);
    expect(tail).toHaveLength(3);
  });

  it("keeps the two neighbours of a window that falls between samples", () => {
    const { points: sliced, insideCount } = sliceByTimeRange(data, {
      start: start + 10 * MINUTE + 1000,
      end: start + 10 * MINUTE + 2000,
    });
    expect(insideCount).toBe(0);
    expect(sliced).toEqual([data[10], data[11]]);
  });

  it("is empty for a window entirely outside the data", () => {
    expect(sliceByTimeRange(data, { start: start - 10 * MINUTE, end: start - 5 * MINUTE }).points).toEqual([]);
    expect(sliceByTimeRange(data, { start: start + 200 * MINUTE, end: start + 300 * MINUTE }).points).toEqual([]);
    expect(sliceByTimeRange([], { start, end: start + MINUTE }).points).toEqual([]);
  });

  it("honours a padding of zero", () => {
    const { points: sliced } = sliceByTimeRange(data, { start: start + MINUTE, end: start + 3 * MINUTE }, 0);
    expect(sliced).toEqual(data.slice(1, 4));
  });
});

describe("splitByGap", () => {
  it("cuts where neighbours are further apart than the threshold", () => {
    const data = [...points(5), ...points(5, (index) => index, MINUTE).map((point) => ({
      ...point,
      x: new Date(point.x.getTime() + 60 * MINUTE),
    }))];
    const segments = splitByGap(data, 10 * MINUTE);
    expect(segments.map((segment) => segment.length)).toEqual([5, 5]);
    expect(segments.flat()).toEqual(data);
  });

  it("keeps one run without a threshold or with a single point", () => {
    const data = points(5);
    expect(splitByGap(data, null)).toEqual([data]);
    expect(splitByGap(data, 0)).toEqual([data]);
    expect(splitByGap([data[0]], MINUTE)).toEqual([[data[0]]]);
    expect(splitByGap([], MINUTE)).toEqual([]);
  });
});

describe("largestTriangleThreeBuckets", () => {
  it("returns the data itself when it fits the budget", () => {
    const data = points(50);
    expect(largestTriangleThreeBuckets(data, 50)).toBe(data);
    expect(largestTriangleThreeBuckets(data, 500)).toBe(data);
  });

  it("keeps exactly the budget, sorted, first and last included", () => {
    const data = points(10_000, (index) => Math.sin(index / 50) * 100);
    const sampled = largestTriangleThreeBuckets(data, 300);
    expect(sampled).toHaveLength(300);
    expect(sampled[0]).toBe(data[0]);
    expect(sampled[299]).toBe(data[9_999]);
    expect(isSorted(sampled)).toBe(true);
    // Real samples, never interpolated ones.
    const originals = new Set(data);
    expect(sampled.every((point) => originals.has(point))).toBe(true);
  });

  it("keeps a lone spike a plain stride would skip", () => {
    const data = points(5_000, (index) => (index === 3_141 ? 1_000 : 10 + (index % 3)));
    const sampled = largestTriangleThreeBuckets(data, 100);
    expect(sampled.some((point) => point.y === 1_000)).toBe(true);
  });

  it("collapses to the end points below a budget of three", () => {
    const data = points(10);
    expect(largestTriangleThreeBuckets(data, 2)).toEqual([data[0], data[9]]);
  });
});

describe("prepareChartSeries", () => {
  it("draws a small series as it is", () => {
    const data = points(20);
    const prepared = prepareChartSeries(series(data), { timeRange: null, pixelWidth: 800 });
    expect(prepared.segments).toEqual([data]);
    expect(prepared.data).toBe(data);
    expect(prepared.sampleCount).toBe(20);
  });

  it("thins a long series to a couple of points per pixel", () => {
    const data = points(50_000, (index) => Math.cos(index / 300) * 40);
    const prepared = prepareChartSeries(series(data), { timeRange: null, pixelWidth: 700 });
    expect(prepared.data.length).toBeLessThanOrEqual(1_400);
    expect(prepared.data.length).toBeGreaterThan(1_000);
    expect(prepared.sampleCount).toBe(50_000);
    expect(prepared.data[0]).toBe(data[0]);
    expect(prepared.data[prepared.data.length - 1]).toBe(data[49_999]);
  });

  it("gives a narrower chart fewer points", () => {
    const data = points(50_000);
    const wide = prepareChartSeries(series(data), { timeRange: null, pixelWidth: 1_600 });
    const narrow = prepareChartSeries(series(data), { timeRange: null, pixelWidth: 300 });
    expect(narrow.data.length).toBeLessThan(wide.data.length / 4);
  });

  it("only draws the visible window", () => {
    const data = points(10_000);
    const prepared = prepareChartSeries(series(data), {
      timeRange: { start: start + 5_000 * MINUTE, end: start + 5_100 * MINUTE },
      pixelWidth: 800,
    });
    expect(prepared.sampleCount).toBe(101);
    expect(prepared.data).toHaveLength(103);
    expect(prepared.data[0]).toBe(data[4_999]);
  });

  it("splits at gaps before thinning, so the hole survives and no false gap appears", () => {
    // Two months of minute samples with a month of sleep between them.
    const monthLength = 30 * 24 * 60;
    const morning = points(monthLength, (index) => index % 7);
    const evening = points(monthLength, (index) => index % 5).map((point) => ({
      ...point,
      x: new Date(point.x.getTime() + 2 * monthLength * MINUTE),
    }));
    const gapThresholdMs = 20 * MINUTE;
    const prepared = prepareChartSeries(series([...morning, ...evening]), {
      timeRange: null,
      pixelWidth: 600,
      gapThresholdMs,
    });
    expect(prepared.segments).toHaveLength(2);
    expect(prepared.data.length).toBeLessThanOrEqual(1_200);
    // Neighbours inside one thinned run are far further apart than the
    // threshold — a caller that re-split the drawn points would tear the
    // line up. The segments are the contract.
    const [first] = prepared.segments;
    const widestStep = Math.max(
      ...first.slice(1).map((point, index) => point.x.getTime() - first[index].x.getTime()),
    );
    expect(widestStep).toBeGreaterThan(gapThresholdMs);
    expect(splitByGap(prepared.data, gapThresholdMs).length).toBeGreaterThan(2);
  });

  it("shares the budget between runs by their size", () => {
    const big = points(9_000);
    const small = points(1_000).map((point) => ({
      ...point,
      x: new Date(point.x.getTime() + 20_000 * MINUTE),
    }));
    const prepared = prepareChartSeries(series([...big, ...small]), {
      timeRange: null,
      pixelWidth: 500,
      gapThresholdMs: 10 * MINUTE,
    });
    const [bigRun, smallRun] = prepared.segments;
    expect(bigRun.length + smallRun.length).toBeLessThanOrEqual(1_000);
    expect(bigRun.length).toBeGreaterThan(smallRun.length * 5);
  });

  it("prepares every category and drops series with nothing in the window", () => {
    const inWindow = series(points(10));
    const outside = series(
      points(10).map((point) => ({ ...point, x: new Date(point.x.getTime() + 500 * MINUTE) })),
      { key: "later" },
    );
    const prepared = prepareChartSeriesByCategory(
      { load: [inWindow, outside], memory: [] },
      { timeRange: { start, end: start + 9 * MINUTE }, pixelWidth: 400 },
    );
    expect(Object.keys(prepared)).toEqual(["load", "memory"]);
    expect(prepared.load.map((chartSeries) => chartSeries.key)).toEqual(["k"]);
    expect(prepared.memory).toEqual([]);
  });

  it("flattens drawn points, optionally per axis", () => {
    const left = prepareChartSeries(series(points(3)), { timeRange: null, pixelWidth: 100 });
    const right = prepareChartSeries(series(points(2), { key: "r", axis: "right" }), {
      timeRange: null,
      pixelWidth: 100,
    });
    expect(flattenChartSeries([left, right])).toHaveLength(5);
    expect(flattenChartSeries([left, right], "left")).toHaveLength(3);
    expect(flattenChartSeries([left, right], "right")).toHaveLength(2);
  });

  it("windows a long history in well under a frame", () => {
    const data = points(500_000, (index) => index % 100, 1000);
    const chartSeries = series(data);
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      prepareChartSeries(chartSeries, {
        timeRange: { start: start + i * 1000 * 1000, end: start + (i + 60) * 1000 * 1000 },
        pixelWidth: 800,
        gapThresholdMs: 20 * MINUTE,
      });
    }
    // 20 brush moves over half a million samples; generous for CI.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("chart layout", () => {
  it("derives the plot widths the logic budgets from the card width", () => {
    expect(metricChartPlotWidth(800)).toBe(800 - 56 - 45);
    expect(brushChartPlotWidth(800)).toBe(800 - 50 - 20);
    expect(metricChartPlotWidth(10)).toBe(0);
  });
});

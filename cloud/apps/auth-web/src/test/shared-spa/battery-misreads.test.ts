// E1002 sits at ~3980 mV all day and drops the odd 1580 mV sample, which the
// Li-ion curve reports as a red 0%. The reading is one-directional — every
// way an ADC read of a divider goes wrong pulls it down — so a sample its
// neighbours contradict is thrown away rather than charted. Pure functions,
// tested from auth-web like the other shared-SPA logic (frontend/ has no
// test runner).
import { describe, expect, it } from "vitest";
import {
  batteryMisreadFlags,
  withoutBatteryMisreads,
} from "../../../../../../frontend/src/utils/batteryMisreads";
import {
  metricCardElementId,
  metricCardFromHash,
  metricCardHash,
} from "../../../../../../frontend/src/scenes/frame/panels/Metrics/metricsLogic";
import type { MetricsType } from "../../../../../../frontend/src/types";

const start = Date.parse("2026-09-01T10:00:00Z");

function sample(
  index: number,
  metrics: Record<string, unknown>,
): MetricsType {
  return {
    id: String(index),
    frame_id: "9994a1e1-9988-4ca5-8c86-26dd763049ee",
    timestamp: new Date(start + index * 5 * 60 * 1000).toISOString(),
    metrics,
  };
}

/** A frame reporting a steady cell, with `misreads` at the given indexes. */
function series(millivolts: number[]): MetricsType[] {
  return millivolts.map((mv, index) =>
    sample(index, {
      event: "metrics",
      batteryMillivolts: mv,
      batteryPercent: Math.max(0, Math.min(100, Math.round((mv - 3000) / 12))),
      onBattery: mv >= 2500,
    }),
  );
}

describe("batteryMisreadFlags", () => {
  it("flags a lone reading far below its neighbours", () => {
    const values = [3980, 3980, 3978, 3980, 1580, 3980, 3978, 3980, 3980];
    expect(batteryMisreadFlags(values, 200)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("flags a misread in the newest sample, with only past neighbours", () => {
    const values = [3980, 3980, 3978, 3980, 3978, 3980, 2716];
    expect(batteryMisreadFlags(values, 200).at(-1)).toBe(true);
  });

  it("flags two misreads in a row (E1004 read 3548 then 3012)", () => {
    const values = [
      3918, 3910, 3902, 3910, 3908, 3548, 3012, 3908, 3914, 3902, 3918,
    ];
    expect(batteryMisreadFlags(values, 200).slice(5, 7)).toEqual([true, true]);
  });

  it("leaves a cell that is genuinely draining alone", () => {
    const values = [3980, 3960, 3940, 3920, 3900, 3880, 3860, 3840, 3820];
    expect(batteryMisreadFlags(values, 200).some(Boolean)).toBe(false);
  });

  it("leaves a cell that is charging alone (E1004 climbed 3900 to 4180)", () => {
    const values = [3988, 3998, 4020, 4038, 4052, 4068, 4094, 4126, 4152];
    expect(batteryMisreadFlags(values, 200).some(Boolean)).toBe(false);
  });

  it("never flags a reading ABOVE its neighbours — the error only reads low", () => {
    const values = [3980, 3980, 3978, 3980, 4190, 3980, 3978, 3980, 3980];
    expect(batteryMisreadFlags(values, 200).some(Boolean)).toBe(false);
  });

  it("says nothing when there are too few neighbours to argue with", () => {
    expect(batteryMisreadFlags([3980, 1580, 3980], 200).some(Boolean)).toBe(
      false,
    );
  });

  it("ignores samples with no reading, as neighbours and as candidates", () => {
    const values = [3980, null, 3978, 3980, null, 1580, 3980, 3978, 3980, 3980];
    const flags = batteryMisreadFlags(values, 200);
    expect(flags[1]).toBe(false);
    expect(flags[4]).toBe(false);
    expect(flags[5]).toBe(true);
  });
});

describe("withoutBatteryMisreads", () => {
  it("strips the whole reading — percent, millivolts and onBattery come off one bad sample", () => {
    const checked = withoutBatteryMisreads(
      series([3980, 3980, 3978, 3980, 1668, 3980, 3978, 3980, 3980]),
    );
    expect(checked.misreadCount).toBe(1);
    expect(checked.metrics[4].metrics).toEqual({ event: "metrics" });
    // Everything else is untouched, object identity included.
    expect(checked.metrics[3].metrics.batteryMillivolts).toBe(3980);
  });

  it("keeps batteryRawMillivolts — reporting what the ADC said is its job", () => {
    const metrics = series([3980, 3980, 3978, 3980, 1668, 3980, 3978, 3980]);
    metrics[4].metrics.batteryRawMillivolts = 1668;
    const checked = withoutBatteryMisreads(metrics);
    expect(checked.metrics[4].metrics).toEqual({
      event: "metrics",
      batteryRawMillivolts: 1668,
    });
  });

  it("returns the samples untouched when the frame has no battery", () => {
    const metrics = [sample(0, { event: "metrics", freeHeapKB: 107 })];
    const checked = withoutBatteryMisreads(metrics);
    expect(checked.misreadCount).toBe(0);
    expect(checked.metrics).toBe(metrics);
  });

  it("leaves a clean series identical", () => {
    const metrics = series([3980, 3980, 3978, 3980, 3978, 3980, 3980, 3982]);
    const checked = withoutBatteryMisreads(metrics);
    expect(checked.misreadCount).toBe(0);
    expect(checked.metrics).toBe(metrics);
  });

  it("catches the whole of one real day on E1002", () => {
    // Every sample the frame reported between 10:16 and 15:54 on 2026-09-01,
    // in order: a flat ~3980 mV cell with ten misreads in it.
    const day = [
      2162, 3988, 3986, 3986, 3986, 3986, 3988, 3986, 3986, 3992, 3986, 3988,
      3986, 3986, 3986, 3986, 3986, 3992, 3982, 3992, 2988, 3982, 3982, 3992,
      3986, 3986, 3992, 3988, 3986, 3992, 3982, 3986, 1668, 3982, 3986, 3982,
      3980, 3980, 3982, 2478, 3980, 3980, 3982, 3978, 1580, 3980, 3980, 3980,
      3978, 3980, 3978, 3978, 3982, 3980, 2764, 3978, 3982, 3324, 3978, 3978,
      3978, 3978, 2716, 3978, 3978, 1736, 3978, 3978, 3978, 3978, 3978, 3978,
      2718,
    ];
    const checked = withoutBatteryMisreads(series(day));
    const stripped = checked.metrics
      .map((metric, index) =>
        metric.metrics.batteryMillivolts === undefined ? day[index] : null,
      )
      .filter((value): value is number => value !== null);
    expect(stripped).toEqual([
      2162, 2988, 1668, 2478, 1580, 2764, 3324, 2716, 1736, 2718,
    ]);
    expect(checked.misreadCount).toBe(10);
  });
});

// The battery glyph beside a frame links here: the Metrics panel, scrolled to
// the battery chart.
describe("metric card deep links", () => {
  it("round-trips a card name through the hash", () => {
    expect(metricCardHash("batteryPercent")).toBe("#metric=batteryPercent");
    expect(metricCardFromHash({ metric: "batteryPercent" })).toBe(
      "batteryPercent",
    );
    expect(metricCardFromHash({ metricsRange: "1h" })).toBe(null);
  });

  it("names an element id the panel puts on the card", () => {
    expect(metricCardElementId("batteryPercent")).toBe(
      "frame-metric-batteryPercent",
    );
  });
});

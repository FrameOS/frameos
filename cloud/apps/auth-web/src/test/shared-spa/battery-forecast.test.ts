// The battery popup's model: the current discharge since the last charge,
// the wake cadence read off the samples, and how the drain scales when the
// frame wakes more or less often. Pure functions, tested from auth-web like
// the other shared-SPA logic (frontend/ has no test runner).
import { describe, expect, it } from "vitest";
import {
  analyzeBattery,
  batteryCadence,
  batteryForecast,
  batterySamplesFromMetrics,
  dischargeSegments,
  forecastCycleOptions,
  formatCycle,
  formatRemaining,
  nearestCycleOption,
  scaledDrainPerHour,
  SLEEP_RATIO,
} from "../../../../../../frontend/src/utils/batteryForecast";
import type { MetricsType } from "../../../../../../frontend/src/types";

const start = Date.parse("2026-09-01T00:00:00Z");
const hour = 3_600_000;
const frameId = "92bef0f7-2019-4f37-8761-f66ef7a9fa86";
const deepSleepFrame = { deep_sleep: false, deep_sleep_on_battery: true };

function sample(
  index: number,
  cycleSeconds: number,
  percent: number,
  extra: Record<string, unknown> = {},
): MetricsType {
  return {
    id: String(index),
    frame_id: frameId,
    timestamp: new Date(start + index * cycleSeconds * 1000).toISOString(),
    metrics: {
      batteryPercent: percent,
      batteryMillivolts: 3300 + percent * 9,
      onBattery: true,
      uptimeSeconds: 63,
      renders: 1,
      wakeCause: "timer",
      ...extra,
    },
  };
}

/** A steady discharge: `perDay` points a day at one sample per `cycleSeconds`. */
function discharge(
  count: number,
  cycleSeconds: number,
  startPercent: number,
  perDay: number,
): MetricsType[] {
  return Array.from({ length: count }, (_, index) =>
    sample(
      index,
      cycleSeconds,
      Math.round(startPercent - (perDay * index * cycleSeconds) / 86400),
    ),
  );
}

describe("batterySamplesFromMetrics", () => {
  it("keeps the battery fields, sorted oldest first, and drops samples without a charge", () => {
    const metrics = [
      sample(2, 900, 88),
      sample(0, 900, 90),
      { ...sample(1, 900, 89), metrics: { load: 0.2 } },
    ];
    const { samples } = batterySamplesFromMetrics(metrics);
    expect(samples.map((s) => s.percent)).toEqual([90, 88]);
    expect(samples[0]).toMatchObject({
      millivolts: 3300 + 90 * 9,
      onBattery: true,
      uptimeSeconds: 63,
      renders: 1,
      wakeCause: "timer",
    });
  });

  it("strips ADC misreads before anything downstream sees them", () => {
    const metrics = discharge(20, 900, 90, 4);
    metrics[10] = sample(10, 900, 0, { batteryMillivolts: 1580 });
    const { samples, misreadCount } = batterySamplesFromMetrics(metrics);
    expect(misreadCount).toBe(1);
    expect(samples).toHaveLength(19);
    expect(samples.every((s) => s.percent > 80)).toBe(true);
  });
});

describe("dischargeSegments", () => {
  it("splits at a charge and leaves samples on external power out of every segment", () => {
    const metrics = [
      ...discharge(8, 900, 40, 4),
      sample(8, 900, 45, { onBattery: false }),
      sample(9, 900, 60, { onBattery: false }),
      ...discharge(8, 900, 100, 4).map((m, index) => ({
        ...m,
        id: String(10 + index),
        timestamp: new Date(start + (10 + index) * 900 * 1000).toISOString(),
      })),
    ];
    const segments = dischargeSegments(batterySamplesFromMetrics(metrics).samples);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.startPercent).toBe(40);
    expect(segments[0]!.samples).toHaveLength(8);
    expect(segments[1]!.startPercent).toBe(100);
    expect(segments[1]!.samples).toHaveLength(8);
  });

  it("treats a jump up on battery as a charge too, and a long silence as a break", () => {
    const metrics = [
      ...discharge(6, 900, 50, 4),
      // Charged over USB but the sample after says "on battery" again.
      ...discharge(6, 900, 98, 4).map((m, index) => ({
        ...m,
        id: String(6 + index),
        timestamp: new Date(start + (6 + index) * 900 * 1000).toISOString(),
      })),
      // Three days of nothing, then more readings.
      ...discharge(6, 900, 96, 4).map((m, index) => ({
        ...m,
        id: String(12 + index),
        timestamp: new Date(start + 72 * hour + index * 900 * 1000).toISOString(),
      })),
    ];
    const segments = dischargeSegments(batterySamplesFromMetrics(metrics).samples);
    expect(segments.map((s) => s.startPercent)).toEqual([50, 98, 96]);
  });

  it("fits the observed drain rate", () => {
    const [segment] = dischargeSegments(
      batterySamplesFromMetrics(discharge(96, 900, 90, 4)).samples,
    );
    expect(segment!.slopePerHour * 24).toBeCloseTo(4, 0);
  });
});

describe("batteryCadence", () => {
  it("reads the wake period and the awake time off the samples", () => {
    const { samples } = batterySamplesFromMetrics(discharge(10, 900, 90, 4));
    expect(batteryCadence(samples)).toEqual({ cycleSeconds: 900, awakeSeconds: 63 });
  });

  it("ignores a long silence when measuring the period", () => {
    const metrics = [
      ...discharge(5, 900, 90, 4),
      ...discharge(5, 900, 80, 4).map((m, index) => ({
        ...m,
        id: String(5 + index),
        timestamp: new Date(start + 72 * hour + index * 900 * 1000).toISOString(),
      })),
    ];
    expect(batteryCadence(batterySamplesFromMetrics(metrics).samples).cycleSeconds).toBe(900);
  });

  it("has nothing to say about one sample", () => {
    const { samples } = batterySamplesFromMetrics([sample(0, 900, 90)]);
    expect(batteryCadence(samples)).toEqual({ cycleSeconds: null, awakeSeconds: 63 });
  });
});

describe("scaledDrainPerHour", () => {
  it("halves (nearly) when a deep-sleeping frame wakes half as often", () => {
    const observed = 4 / 24;
    const doubled = scaledDrainPerHour(observed, 900, 63, 1800, true);
    // A little over half: the sleep floor is paid either way.
    expect(doubled).toBeLessThan((observed / 2) * 1.1);
    expect(doubled).toBeGreaterThan(observed / 2);
  });

  it("levels off at the sleep floor for very long cycles", () => {
    const observed = 4 / 24;
    const daily = scaledDrainPerHour(observed, 900, 63, 86400, true);
    const awake = 63 / 900;
    const k = observed / (awake + (1 - awake) * SLEEP_RATIO);
    expect(daily).toBeGreaterThan(k * SLEEP_RATIO);
    expect(daily).toBeLessThan(observed / 10);
  });

  it("is unchanged without deep sleep — the frame is awake all the time anyway", () => {
    expect(scaledDrainPerHour(0.5, 900, 63, 3600, false)).toBe(0.5);
  });
});

describe("analyzeBattery + batteryForecast", () => {
  it("forecasts from the current discharge and scales with the wake cadence", () => {
    // Four days at 15 minutes, 4 points a day: 96 → 80.
    const metrics = discharge(4 * 96, 900, 96, 4);
    const analysis = analyzeBattery(metrics, deepSleepFrame);
    const now = Date.parse(metrics[metrics.length - 1]!.timestamp);
    expect(analysis.confidence).toBe("good");
    expect(analysis.reason).toBeNull();
    expect(analysis.deepSleep).toBe(true);
    expect(analysis.drainPerDay).toBeCloseTo(4, 0);
    expect(analysis.cadence.cycleSeconds).toBe(900);

    const current = batteryForecast(analysis, 900, now);
    expect(current).not.toBeNull();
    expect(current!.hoursRemaining / 24).toBeCloseTo(80 / 4, 0);
    expect(current!.emptyAt).toBeCloseTo(now + current!.hoursRemaining * hour, -3);

    // Four times the cycle buys a bit over three times the life: the sleep
    // floor is paid either way.
    const slower = batteryForecast(analysis, 3600, now);
    expect(slower!.hoursRemaining).toBeGreaterThan(current!.hoursRemaining * 3);
    expect(slower!.hoursRemaining).toBeLessThan(current!.hoursRemaining * 4);
    const faster = batteryForecast(analysis, 300, now);
    expect(faster!.hoursRemaining).toBeLessThan(current!.hoursRemaining / 2.5);
  });

  it("counts the time since the newest reading against what is left", () => {
    const metrics = discharge(4 * 96, 900, 96, 4);
    const analysis = analyzeBattery(metrics, deepSleepFrame);
    const latestAt = Date.parse(metrics[metrics.length - 1]!.timestamp);
    const fresh = batteryForecast(analysis, 900, latestAt)!;
    const later = batteryForecast(analysis, 900, latestAt + 12 * hour)!;
    expect(fresh.hoursRemaining - later.hoursRemaining).toBeCloseTo(12, 5);
  });

  it("uses only the discharge since the last charge", () => {
    const before = discharge(48, 900, 30, 8);
    const charged = [
      sample(48, 900, 50, { onBattery: false }),
      sample(49, 900, 100, { onBattery: false }),
    ];
    const after = discharge(96, 900, 100, 4).map((m, index) => ({
      ...m,
      id: String(50 + index),
      timestamp: new Date(start + (50 + index) * 900 * 1000).toISOString(),
    }));
    const analysis = analyzeBattery([...before, ...charged, ...after], deepSleepFrame);
    expect(analysis.segment?.startPercent).toBe(100);
    expect(analysis.segment?.samples).toHaveLength(96);
    expect(analysis.drainPerDay).toBeCloseTo(4, 0);
  });

  it("has no forecast while plugged in", () => {
    const metrics = [...discharge(20, 900, 60, 4), sample(20, 900, 62, { onBattery: false })];
    const analysis = analyzeBattery(metrics, deepSleepFrame);
    expect(analysis.reason).toBe("plugged-in");
    expect(analysis.latest?.onBattery).toBe(false);
    expect(batteryForecast(analysis, 900, start + 21 * 900 * 1000)).toBeNull();
  });

  it("refuses to guess from a handful of readings, or from no drain at all", () => {
    expect(analyzeBattery(discharge(4, 900, 90, 4), deepSleepFrame).reason).toBe("too-few-samples");
    expect(analyzeBattery(discharge(20, 900, 90, 0), deepSleepFrame).reason).toBe("no-drain");
    expect(analyzeBattery([], deepSleepFrame).reason).toBe("no-samples");
  });

  it("calls a short discharge rough, and a frame without deep sleep flat", () => {
    const short = analyzeBattery(discharge(16, 900, 90, 8), deepSleepFrame);
    expect(short.confidence).toBe("rough");
    expect(short.drainPerDay).not.toBeNull();

    const awake = analyzeBattery(discharge(96, 900, 90, 8), {
      deep_sleep: false,
      deep_sleep_on_battery: false,
    });
    expect(awake.deepSleep).toBe(false);
    const now = start + 96 * 900 * 1000;
    expect(batteryForecast(awake, 3600, now)?.hoursRemaining).toBeCloseTo(
      batteryForecast(awake, 900, now)!.hoursRemaining,
      5,
    );
  });
});

describe("slider helpers", () => {
  it("offers the observed cadence as a stop, rounded to the half minute", () => {
    const options = forecastCycleOptions(897);
    expect(options).toContain(900);
    expect(options).toEqual([...options].sort((a, b) => a - b));
    expect(forecastCycleOptions(1250)).toContain(1260);
    expect(nearestCycleOption(options, 897)).toBe(900);
    expect(nearestCycleOption(options, null)).toBe(900);
    expect(nearestCycleOption(options, 2000)).toBe(1800);
  });

  it("formats cycles and remaining time for people", () => {
    expect(formatCycle(900)).toBe("15 min");
    expect(formatCycle(5400)).toBe("1 h 30 min");
    expect(formatCycle(86400)).toBe("1 day");
    expect(formatRemaining(0.5)).toBe("under an hour");
    expect(formatRemaining(30)).toBe("about 30 hours");
    expect(formatRemaining(24 * 9.6)).toBe("about 9.5 days");
    expect(formatRemaining(24 * 40)).toBe("about 40 days");
    expect(formatRemaining(24 * 120)).toBe("about 4 months");
    expect(formatRemaining(24 * 400)).toBe("over a year");
  });
});

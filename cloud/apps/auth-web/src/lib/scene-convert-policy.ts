// Who pays for the Nim → JavaScript converter's model pass, and how much of
// it the platform's own key may buy: shared by POST /api/scenes/convert (the
// public converter, /nim-converter) and the device-scene import, which
// converts a frame's compiled scenes on the owner's say
// (device-scene-convert.ts).
//
// Conversion is an absorbed surface (packages/ledger metering.ts): billed to
// nobody and capped for nobody, so neither the AI switch nor the daily cap
// applies. What bounds it is this: a per-bucket hourly and a global daily
// budget of model CALLS on the platform key, and a ceiling of calls per scene
// whichever key pays.

import type { ConversionReport, ModelPort } from "@frameos-cloud/scene-convert";
import { ModelBudgetExceededError } from "@frameos-cloud/scene-convert";
import { countMissingPrimitives } from "./ai/missing-primitives";
import type { SceneConversionRecord } from "./ai/telemetry";
import { checkRateLimit } from "./rate-limit";

// The platform key pays for anonymous conversions unless the operator says
// otherwise — the whole point of the page is that a self-hoster with no
// account can use it. FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS=none turns it
// off; the budgets below are per bucket per hour and global per day.
export function sharedConverterKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const access = (env.FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS ?? "all").trim().toLowerCase();
  if (access === "none" || access === "off" || access === "0") {
    return undefined;
  }
  return env.OPENAI_API_KEY?.trim() || undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Per scene, on top of the shared-key budget: enough for a large scene's
// apps and code nodes at three attempts each, far below "unbounded".
export const maxModelCallsPerScene = 60;

export function sharedKeyPerBucketPerHour() {
  return positiveInt(process.env.FRAMEOS_SCENE_CONVERT_PER_ADDRESS_PER_HOUR, 6);
}

function sharedKeyPerDay() {
  return positiveInt(process.env.FRAMEOS_SCENE_CONVERT_PER_DAY, 200);
}

// One unit of the shared-key budget: the bucket's window first (the caller's
// address on the public converter, the account on an import), the global
// daily one only when that passed (so a spent bucket does not eat into
// everyone's day). Both rate-limit keys are what the route tests pin.
export async function spendSharedModelBudget(
  bucket: string,
): Promise<{ allowed: boolean; resetAt: number }> {
  const perBucket = await checkRateLimit(`scenes:convert-model:${bucket}`, {
    limit: sharedKeyPerBucketPerHour(),
    windowMs: 60 * 60 * 1000,
  });
  if (!perBucket.allowed) {
    return { allowed: false, resetAt: perBucket.resetAt };
  }
  const global = await checkRateLimit("scenes:convert-model:global", {
    limit: sharedKeyPerDay(),
    windowMs: 24 * 60 * 60 * 1000,
  });
  return { allowed: global.allowed, resetAt: global.resetAt };
}

// The shared-key port pays one budget unit per call. The public converter
// pays for the first call up front (an exhausted budget is a 429 before any
// work starts), so `prepaid` is 1 there; the import pays as it goes. When the
// budget runs out mid-conversion the converter reports the rest of the scene
// as needs_model instead of calling.
export function meteredSharedPort(port: ModelPort, bucket: string, prepaid = 1): ModelPort {
  let paidAhead = prepaid;
  return async (modelRequest, signal) => {
    if (paidAhead > 0) {
      paidAhead -= 1;
    } else {
      const spent = await spendSharedModelBudget(bucket);
      if (!spent.allowed) {
        throw new ModelBudgetExceededError(sharedKeyPerBucketPerHour());
      }
    }
    return port(modelRequest, signal);
  };
}

/** The `scene_convert` telemetry event for one conversion run. */
export function sceneConversionTelemetry(input: {
  distinctId: string;
  keySource: SceneConversionRecord["keySource"];
  requestId: string;
  results: ConversionReport[];
  scenes: number;
  startedAt: number;
  lintErrors?: number;
  renderErrors?: number | null;
  error?: string;
}): SceneConversionRecord {
  const items = input.results.flatMap((report) => report.items);
  return {
    apps: items.filter((item) => item.kind === "app" && item.status === "converted").length,
    codeNodesDeterministic: items.filter((item) => item.kind === "code" && item.status === "converted" && item.via === "deterministic").length,
    codeNodesModel: items.filter((item) => item.kind === "code" && item.status === "converted" && item.via === "model").length,
    distinctId: input.distinctId,
    durationMs: Date.now() - input.startedAt,
    error: input.error,
    keySource: input.keySource,
    lintErrors: input.lintErrors ?? 0,
    manualPortPrimitives: countMissingPrimitives(
      items.flatMap((item) => (item.status === "needs_manual_port" ? [item.reason] : [])),
    ),
    model: input.results.find((report) => report.model)?.model,
    modelCalls: input.results.reduce((n, report) => n + report.modelCalls, 0),
    needsManualPort: input.results.reduce((n, report) => n + report.needsManualPort.length, 0),
    needsModel: input.results.reduce((n, report) => n + report.needsModel.length, 0),
    renderErrors: input.renderErrors ?? null,
    requestId: input.requestId,
    scenes: input.scenes,
    usage: input.results.reduce(
      (total, report) => ({
        inputTokens: total.inputTokens + report.usage.inputTokens,
        outputTokens: total.outputTokens + report.usage.outputTokens,
        reasoningTokens: total.reasoningTokens + report.usage.reasoningTokens,
      }),
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    ),
  };
}

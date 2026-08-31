import {
  convertScenes,
  DEFAULT_CONVERT_MODEL,
  ModelRequestError,
  openAiModelPort,
  rewrapScenes,
  unwrapScenes,
  type ConversionReport,
  type ModelPort,
  type Scene,
} from "@frameos-cloud/scene-convert";
import { NextRequest, NextResponse } from "next/server";
import { resolveAiCredentials } from "../../../../src/lib/ai/api-key";
import { appCatalog, jsTypeDeclarations } from "../../../../src/lib/ai/context";
import { lintScenes, type LintIssue } from "../../../../src/lib/ai/scene-lint";
import { validateScenePayload } from "../../../../src/lib/ai/scene-utils";
import { captureSceneConversion } from "../../../../src/lib/ai/telemetry";
import { meterAiUsage, type CredentialSource } from "../../../../src/lib/billing";
import { csrfResponse } from "../../../../src/lib/csrf";
import { jsonError } from "../../../../src/lib/device-flow";
import { hasDatabaseUrl } from "../../../../src/lib/env";
import { logWarn } from "../../../../src/lib/log";
import { checkRateLimit, clientKey, rateLimitResponse } from "../../../../src/lib/rate-limit";
import {
  renderScenes,
  rendererAvailable,
  SceneRenderError,
} from "../../../../src/lib/scene-render";
import { readSession } from "../../../../src/lib/session";
import { createDb } from "@frameos-cloud/db";

export const runtime = "nodejs";
// One scene-local app is one model call of up to four minutes; a scene
// with several is longer. nginx's proxy_read_timeout has to agree.
export const maxDuration = 300;

const maxScenesPerRequest = 20;
const maxScenesRendered = 3;
const maxPayloadBytes = 3 * 1024 * 1024;
const renderTimeoutMs = 20_000;

// The Nim → JavaScript scene converter as a public API
// (docs/nim-to-js-conversion.md). No login: a compiled scene is usually on
// a self-hosted backend whose owner has no cloud account, and the page at
// /nim-converter is meant to be the shortest path from "my deploys need a
// source build" to "they don't". Per-address rate limits stand in for the
// account; the model pass on the platform's key has its own tighter
// per-address limit and a global daily budget, and a caller can always pay
// for it themselves with `openaiApiKey` (used for this request, never
// stored). Signed in with an OpenAI key in Settings, that key is used.
//
// Body: {"scene": {...}} | {"scenes": [...]} | a bare scene | a bare array,
//       plus optional "dryRun" (deterministic pass only), "openaiApiKey",
//       "render" (default true: one headless render per converted scene).
// Reply: {ok, scene | scenes, reports, lint, render, model}. The converted
// JSON comes back whether or not everything converted — `ok` and
// `reports[*].needsModel` / `needsManualPort` say what is left.
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "scenes:convert", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const startedAt = Date.now();
  const requestId = globalThis.crypto.randomUUID();

  // Not readJsonObject: a bare scenes.json array is a valid body here.
  const raw: unknown = await request.json().catch(() => undefined);
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const input = Array.isArray(raw) ? raw : body.scene !== undefined ? body.scene : body.scenes !== undefined ? { scenes: body.scenes } : body;
  let unwrapped: ReturnType<typeof unwrapScenes>;
  try {
    unwrapped = unwrapScenes(input);
  } catch {
    return jsonError("invalid_scenes", 400, {
      hint: 'Send {"scene": {...}}, {"scenes": [...]}, one scene object or an array of scenes.',
    });
  }
  const { scenes, shape } = unwrapped;
  if (scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }
  if (scenes.length > maxScenesPerRequest) {
    return jsonError("too_many_scenes", 400, { max_scenes: maxScenesPerRequest });
  }
  if (JSON.stringify(scenes).length > maxPayloadBytes) {
    return jsonError("scenes_payload_too_large", 413, { max_bytes: maxPayloadBytes });
  }
  if (scenes.some((scene) => !scene || typeof scene !== "object" || typeof (scene as Scene).id !== "string")) {
    return jsonError("invalid_scenes", 400, { hint: "every scene needs a string id" });
  }
  const dryRun = body.dryRun === true;
  const wantsRender = body.render !== false;

  // --- whose OpenAI key ------------------------------------------------------
  let apiKey: string | undefined;
  let keySource: "request" | "account" | "shared" | "none" = "none";
  let model = DEFAULT_CONVERT_MODEL;
  let reasoningEffort: string | undefined;
  let distinctId = "anonymous";
  let accountId: string | null = null;
  if (!dryRun) {
    const requestKey = typeof body.openaiApiKey === "string" ? body.openaiApiKey.trim() : "";
    if (requestKey) {
      if (requestKey.length < 20 || requestKey.length > 256) {
        return jsonError("invalid_openai_key", 400);
      }
      apiKey = requestKey;
      keySource = "request";
    }
    // The account's own key only for a same-origin request: the session
    // cookie is SameSite=Lax, so a cross-site POST carries none anyway, but
    // the origin check is the rule every cookie-authenticated mutation follows.
    const session = csrfResponse(request) ? undefined : await readSession();
    if (session?.accountId) {
      distinctId = session.accountId;
      accountId = session.accountId;
      if (!apiKey && hasDatabaseUrl()) {
        const credentials = await resolveAiCredentials(createDb(), session.accountId);
        if (credentials?.source === "account") {
          apiKey = credentials.apiKey;
          keySource = "account";
          model = credentials.model;
          reasoningEffort = credentials.reasoningEffort;
        }
      }
    }
    if (!apiKey) {
      const shared = sharedConverterKey();
      if (shared) {
        const perAddress = await checkRateLimit(`scenes:convert-model:${clientKey(request)}`, {
          limit: sharedKeyPerAddressPerHour(),
          windowMs: 60 * 60 * 1000,
        });
        const global = perAddress.allowed
          ? await checkRateLimit("scenes:convert-model:global", {
              limit: sharedKeyPerDay(),
              windowMs: 24 * 60 * 60 * 1000,
            })
          : perAddress;
        if (!perAddress.allowed || !global.allowed) {
          const resetAt = perAddress.allowed ? global.resetAt : perAddress.resetAt;
          const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
          return NextResponse.json(
            {
              error: "model_budget_exhausted",
              hint: "The free model pass is out of budget for now. Retry later, send your own key as openaiApiKey, or run the CLI.",
              retry_after: retryAfter,
            },
            { headers: { "retry-after": String(retryAfter) }, status: 429 },
          );
        }
        apiKey = shared;
        keySource = "shared";
      }
    }
  }

  // --- convert --------------------------------------------------------------
  const port: ModelPort | undefined = apiKey
    ? openAiModelPort({ apiKey, model, reasoningEffort })
    : undefined;
  let results: Awaited<ReturnType<typeof convertScenes>>;
  try {
    results = await convertScenes(scenes as Scene[], {
      model: port,
      modelName: port ? model : undefined,
      signal: request.signal,
      tool: "cloud",
      typeDeclarations: jsTypeDeclarations(),
    });
  } catch (error) {
    if (error instanceof ModelRequestError) {
      captureSceneConversion(telemetryRecord({ distinctId, error: `openai_${error.status}`, keySource, requestId, results: [], scenes: scenes.length, startedAt }));
      if (keySource === "request" && (error.status === 401 || error.status === 403)) {
        return jsonError("invalid_openai_key", 400, { detail: error.message });
      }
      logWarn("scenes.convert.model_failed", { requestId, status: error.status });
      return jsonError("model_failed", 502, { detail: error.message });
    }
    throw error;
  }
  const converted = results.map((result) => result.scene);
  const reports = results.map((result) => result.report);

  // --- verify -----------------------------------------------------------------
  const shapeErrors = validateScenePayload({ scenes: converted });
  const lint = shapeErrors.length
    ? { errors: shapeErrors.map((message) => ({ message, scene: "payload" })), warnings: [] as ReturnType<typeof issue>[] }
    : (() => {
        const result = lintScenes(converted, { catalog: appCatalog() });
        return { errors: result.errors.map(issue), warnings: result.warnings.map(issue) };
      })();

  let render: RenderCheck[] | null = null;
  if (wantsRender && !dryRun && rendererAvailable() && converted.length <= maxScenesRendered) {
    render = [];
    for (const [index, scene] of converted.entries()) {
      if (reports[index]?.executionAfter !== "interpreted") {
        continue;
      }
      render.push(await renderCheck(scene));
    }
  }

  const ok = reports.every((report) => report.executionAfter === "interpreted");
  captureSceneConversion(
    telemetryRecord({
      distinctId,
      keySource,
      lintErrors: lint.errors.length,
      renderErrors: render ? render.reduce((n, check) => n + check.errors.length, 0) : null,
      requestId,
      results: reports,
      scenes: scenes.length,
      startedAt,
    }),
  );

  const usage = reports.reduce(
    (total, report) => ({
      inputTokens: total.inputTokens + report.usage.inputTokens,
      outputTokens: total.outputTokens + report.usage.outputTokens,
      reasoningTokens: total.reasoningTokens + report.usage.reasoningTokens,
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
  const modelCalls = reports.reduce((n, report) => n + report.modelCalls, 0);
  if (modelCalls > 0) {
    // The request id is the turn: one conversion, however many scenes and
    // model calls it took. A caller who sent their own key pays the provider
    // directly, exactly like an account key does, so both meter as "account"
    // and cost us nothing; only the platform's own key is our bill.
    //
    // That bill stays ours. `scene_convert` is an absorbed surface in the
    // ledger (packages/ledger/src/metering.ts): whichever of our keys pays,
    // the turn books as COGS and is charged to nobody. We are the ones
    // asking people off the legacy compiled path, so we pay for the trip —
    // and Phase 3 handing this route a billable key changes nothing about
    // that, which is why the policy lives in the ledger and not in a
    // `credentialSource` this route happens not to pass today.
    const credentialSource: CredentialSource =
      keySource === "shared" ? "shared" : "account";
    await meterAiUsage({
      accountId,
      credentialSource,
      model: reports.find((report) => report.model)?.model ?? model,
      rounds: modelCalls,
      surface: "scene_convert",
      turnId: requestId,
      usage,
    });
  }
  const output = rewrapScenes(input, converted, shape);
  return NextResponse.json(
    {
      ok,
      ...(shape === "scene" ? { scene: output } : { scenes: shape === "array" ? output : (output as { scenes: unknown }).scenes }),
      reports,
      lint,
      render,
      model: {
        calls: modelCalls,
        name: port ? (reports.find((report) => report.model)?.model ?? model) : null,
        source: keySource,
        usage,
      },
      request_id: requestId,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// The API's own usage notes, so `curl` with no body explains itself.
export function GET() {
  return NextResponse.json(
    {
      body: {
        dryRun: "optional boolean — deterministic pass only, no model",
        openaiApiKey: "optional string — pay for the model pass yourself; used for this request only, never stored",
        render: "optional boolean (default true) — one headless render per converted scene, when the runtime is installed",
        scene: "one scene object (or `scenes`: an array; a bare scene / array works too)",
      },
      docs: "https://github.com/FrameOS/frameos/blob/main/docs/nim-to-js-conversion.md",
      endpoint: "POST /api/scenes/convert",
      limits: {
        max_scenes: maxScenesPerRequest,
        max_bytes: maxPayloadBytes,
        note: "rate limited per address; the free model pass has a per-address hourly and a global daily budget (429 model_budget_exhausted says when to retry)",
      },
      page: "/nim-converter",
      reply: "{ok, scene | scenes, reports, lint, render, model}",
      shared_model_pass: Boolean(sharedConverterKey()),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

type RenderCheck = { sceneId: string; ok: boolean; renderMs: number | null; errors: string[]; logs: string[] };

async function renderCheck(scene: Scene): Promise<RenderCheck> {
  try {
    const result = await renderScenes({
      height: 480,
      scenes: [scene],
      timeoutMs: renderTimeoutMs,
      width: 800,
    });
    return {
      errors: result.errors.slice(0, 20),
      logs: result.logs.slice(-20),
      ok: result.errors.length === 0,
      renderMs: result.renderMs,
      sceneId: scene.id,
    };
  } catch (error) {
    if (error instanceof SceneRenderError) {
      return { errors: [`${error.code}: ${error.message}`], logs: error.logs.slice(-20), ok: false, renderMs: null, sceneId: scene.id };
    }
    throw error;
  }
}

function issue(entry: LintIssue) {
  return { message: entry.message, ...(entry.node ? { node: entry.node } : {}), scene: entry.scene };
}

// The platform key pays for anonymous conversions unless the operator says
// otherwise — the whole point of the page is that a self-hoster with no
// account can use it. FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS=none turns it
// off; the budgets below are per address per hour and global per day.
export function sharedConverterKey(env: Record<string, string | undefined> = process.env): string | undefined {
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

function sharedKeyPerAddressPerHour() {
  return positiveInt(process.env.FRAMEOS_SCENE_CONVERT_PER_ADDRESS_PER_HOUR, 6);
}

function sharedKeyPerDay() {
  return positiveInt(process.env.FRAMEOS_SCENE_CONVERT_PER_DAY, 200);
}

function telemetryRecord(input: {
  distinctId: string;
  keySource: "request" | "account" | "shared" | "none";
  requestId: string;
  results: ConversionReport[];
  scenes: number;
  startedAt: number;
  lintErrors?: number;
  renderErrors?: number | null;
  error?: string;
}) {
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

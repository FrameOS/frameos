// Convert the compiled scenes a frame reported (`scenes_get`'s
// `compiled_scenes`, device-scenes.ts) so the import can bring them into the
// account too. Only on the owner's say: the import banner and MCP's
// frame_device_scenes_import offer it, nothing converts by itself.
//
// The same converter as /nim-converter (@frameos-cloud/scene-convert) under
// the same policy (scene-convert-policy.ts): the account's own OpenAI key
// when it has one, else the platform key within its shared budget — counted
// per account here, per address on the public page — else the deterministic
// pass alone. Conversion is an absorbed surface: metered as `scene_convert`,
// billed to nobody, and neither the AI switch nor the daily cap applies.
//
// A scene the converter could not finish stays compiled, and the store
// refuses compiled scenes, so it is reported, not imported:
// `conversion_needs_model` when only the model pass is missing (no key, or
// the shared budget ran out: a later import can finish it), and
// `conversion_incomplete` when something has no port at all (/nim-converter
// says what).

import {
  convertScenes,
  DEFAULT_CONVERT_MODEL,
  ModelRequestError,
  openAiModelPort,
  type ConversionReport,
  type ModelPort,
  type Scene,
} from "@frameos-cloud/scene-convert";
import { createDb } from "@frameos-cloud/db";
import { resolveAiCredentials } from "./ai/api-key";
import { jsTypeDeclarations } from "./ai/context";
import { captureSceneConversion } from "./ai/telemetry";
import { meterAiUsage } from "./billing";
import type { DeviceScene } from "./device-scenes";
import { logWarn } from "./log";
import { PhotoLinkRedactor } from "./photos/share-links-in-scenes";
import { retireAppsInScenes } from "./retired-apps";
import {
  meteredSharedPort,
  sceneConversionTelemetry,
  sharedConverterKey,
} from "./scene-convert-policy";

type Database = ReturnType<typeof createDb>;

// An import converts at most this many scenes per call; the rest wait for
// "Import the rest". Each can take a few model calls of up to minutes, and
// the import is one request holding the frame's import claim.
export const maxConversionsPerImport = 3;
// Fewer than the public converter's 60: an import is not where a
// pathological scene should spend an hour of someone's key.
const maxModelCallsPerImportedScene = 20;

export type DeviceSceneConversion =
  | { ok: true; scene: DeviceScene }
  | {
      ok: false;
      reason: "conversion_failed" | "conversion_incomplete" | "conversion_needs_model";
    };

type KeySource = "account" | "shared" | "none";

async function conversionPort(
  db: Database,
  accountId: string,
): Promise<{ keySource: KeySource; model: string; port?: ModelPort }> {
  const credentials = await resolveAiCredentials(db, accountId);
  if (credentials?.source === "account") {
    return {
      keySource: "account",
      model: credentials.model,
      port: openAiModelPort({
        apiKey: credentials.apiKey,
        model: credentials.model,
        reasoningEffort: credentials.reasoningEffort,
      }),
    };
  }
  const shared = sharedConverterKey();
  if (shared) {
    return {
      keySource: "shared",
      model: DEFAULT_CONVERT_MODEL,
      // Paid per call, none ahead: a scene the deterministic pass finishes
      // spends nothing.
      port: meteredSharedPort(
        openAiModelPort({ apiKey: shared, model: DEFAULT_CONVERT_MODEL }),
        `account:${accountId}`,
        0,
      ),
    };
  }
  return { keySource: "none", model: DEFAULT_CONVERT_MODEL };
}

/**
 * Convert the given compiled device scenes, one result per scene in order.
 * A converted scene keeps its id (the frame's copy and the cloud's stay the
 * same public scene) and carries `settings.convertedFrom`.
 */
export async function convertDeviceScenes(
  db: Database,
  input: { accountId: string; scenes: DeviceScene[] },
): Promise<DeviceSceneConversion[]> {
  if (input.scenes.length === 0) {
    return [];
  }
  const startedAt = Date.now();
  const requestId = globalThis.crypto.randomUUID();
  const { keySource, model, port } = await conversionPort(db, input.accountId);
  // The model pass reads the scenes: a Photos share link in one reaches it
  // as a placeholder and comes back as itself (as in the public converter).
  const photoLinks = new PhotoLinkRedactor();
  const outcomes: DeviceSceneConversion[] = [];
  const reports: ConversionReport[] = [];
  for (const scene of input.scenes) {
    try {
      const [result] = await convertScenes(photoLinks.redact([scene as Scene]), {
        maxModelCalls: maxModelCallsPerImportedScene,
        model: port,
        modelName: port ? model : undefined,
        tool: "cloud",
        typeDeclarations: jsTypeDeclarations(),
      });
      if (!result) {
        outcomes.push({ ok: false, reason: "conversion_failed" });
        continue;
      }
      const report = photoLinks.restore(result.report);
      reports.push(report);
      if (report.executionAfter !== "interpreted") {
        outcomes.push({
          ok: false,
          reason:
            report.needsManualPort.length === 0 && report.needsModel.length > 0
              ? "conversion_needs_model"
              : "conversion_incomplete",
        });
        continue;
      }
      const converted = photoLinks.restore(result.scene) as DeviceScene;
      // A compiled scene from before a Nim app was retired can name it
      // (data/immich): it imports as the JavaScript app that replaced it.
      retireAppsInScenes([converted]);
      outcomes.push({ ok: true, scene: { ...converted, id: scene.id } });
    } catch (error) {
      if (!(error instanceof ModelRequestError)) {
        throw error;
      }
      logWarn("device_scenes.convert_model_failed", {
        accountId: input.accountId,
        requestId,
        status: error.status,
      });
      outcomes.push({ ok: false, reason: "conversion_failed" });
    }
  }

  captureSceneConversion(
    sceneConversionTelemetry({
      distinctId: input.accountId,
      keySource,
      requestId,
      results: reports,
      scenes: input.scenes.length,
      startedAt,
    }),
  );
  const modelCalls = reports.reduce((n, report) => n + report.modelCalls, 0);
  if (modelCalls > 0) {
    // One import is one turn, however many scenes it converted. The surface
    // is absorbed in the ledger: COGS on the platform key, nothing on the
    // account's own.
    await meterAiUsage({
      accountId: input.accountId,
      credentialSource: keySource === "shared" ? "shared" : "account",
      model: reports.find((report) => report.model)?.model ?? model,
      rounds: modelCalls,
      surface: "scene_convert",
      turnId: requestId,
      usage: reports.reduce(
        (total, report) => ({
          inputTokens: total.inputTokens + report.usage.inputTokens,
          outputTokens: total.outputTokens + report.usage.outputTokens,
          reasoningTokens: total.reasoningTokens + report.usage.reasoningTokens,
        }),
        { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      ),
    });
  }
  return outcomes;
}

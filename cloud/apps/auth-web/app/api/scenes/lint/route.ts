import { NextRequest, NextResponse } from "next/server";
import { appCatalog, knownAppKeywords } from "../../../../src/lib/ai/context";
import { lintScenes } from "../../../../src/lib/ai/scene-lint";
import {
  type JsonObject,
  validateAppKeywords,
  validateScenePayload,
} from "../../../../src/lib/ai/scene-utils";
import { jsonError, readJsonObject } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

const maxScenesPerLint = 20;
const maxLintBytes = 3 * 1024 * 1024;

// The AI chat's delivery gate, exposed: the shape validation, the app
// keyword check against the bundled catalog and the deep structural lint,
// on any scenes JSON. Read-only — nothing is saved — but signed-in only, so
// the cost of linting a 3 MB payload has an account behind it. Body:
// {"scenes": [...]}; the reply separates hard errors (what publishing and
// the AI refuse) from warnings (what merely looks off).
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "scenes:lint", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const body = await readJsonObject(request);
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }
  if (body.scenes.length > maxScenesPerLint) {
    return jsonError("too_many_scenes", 400, { max_scenes: maxScenesPerLint });
  }
  if (JSON.stringify(body.scenes).length > maxLintBytes) {
    return jsonError("scenes_payload_too_large", 413, {
      max_bytes: maxLintBytes,
    });
  }

  const payload: JsonObject = { scenes: body.scenes };
  const shape = validateScenePayload(payload);
  const keywords = shape.length
    ? []
    : validateAppKeywords(payload, knownAppKeywords());
  const lint = shape.length
    ? { errors: [], warnings: [] }
    : lintScenes(body.scenes, { catalog: appCatalog() });

  const errors = [
    ...shape.map((message) => ({ message, scene: "payload" })),
    ...keywords.map((message) => ({ message, scene: "payload" })),
    ...lint.errors.map((issue) => ({
      message: issue.message,
      ...(issue.node ? { node: issue.node } : {}),
      scene: issue.scene,
    })),
  ];
  const warnings = lint.warnings.map((issue) => ({
    message: issue.message,
    ...(issue.node ? { node: issue.node } : {}),
    scene: issue.scene,
  }));

  return NextResponse.json(
    { errors, ok: errors.length === 0, warnings },
    { headers: { "cache-control": "no-store" } },
  );
}

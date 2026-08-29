import { and, desc, eq, isNull } from "drizzle-orm";
import { storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "../../../../src/lib/blobs";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import {
  defaultRenderTimeoutMs,
  maxRenderDimension,
  maxRenderPixels,
  minRenderDimension,
  renderScenes,
  SceneRenderError,
} from "../../../../src/lib/scene-render";
import { extractScenesFromZip } from "../../../../src/lib/scene-title";
import { readSession } from "../../../../src/lib/session";
import {
  canAccessPrivateScene,
  canViewPulledScene,
} from "../../../../src/lib/store-auth";
import { maxScenesPayloadBytes } from "../../../../src/lib/frames";

export const runtime = "nodejs";
export const maxDuration = 60;

const maxScenesPerRender = 20;

// A preview frame of a scene, rendered on the server by the same wasm
// runtime the browser editor's live preview runs (src/lib/scene-render.ts).
// Two sources, one call: `scene_id` (+ optional `version`) renders a stored
// scene under the store's own access rules — public ones for everyone
// signed in, private ones for their owner — and `scenes` renders JSON that
// was never saved. Signed-in only and rate limited per account: a render
// holds a 64 MB wasm heap for up to `timeout` seconds.
//
// Body: { scene_id? | scenes?, version?, scene?, width?, height?, time_zone?,
//         settings?, states?, format?: "png" | "json" }
// Reply: image/png by default; `format: "json"` (or Accept: application/json)
// returns {png_base64, width, height, render_ms, logs, errors, state}.
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "scenes:render", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const accountLimited = await identityRateLimitResponse(
    session.accountId,
    "scenes:render",
    { limit: 60, windowMs: 15 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const width = dimension(body.width, 800);
  const height = dimension(body.height, 480);
  if (width === null || height === null || width * height > maxRenderPixels) {
    return jsonError("invalid_dimensions", 400, {
      max_dimension: maxRenderDimension,
      max_pixels: maxRenderPixels,
      min_dimension: minRenderDimension,
    });
  }
  const timeZone =
    typeof body.time_zone === "string" && isValidTimeZone(body.time_zone)
      ? body.time_zone
      : "UTC";
  const selectedScene =
    typeof body.scene === "string" && body.scene.length <= 256
      ? body.scene
      : undefined;
  const settings = plainObject(body.settings);
  const states = plainObject(body.states);
  const wantsJson =
    body.format === "json" ||
    (body.format === undefined &&
      request.headers.get("accept")?.includes("application/json") === true &&
      !request.headers.get("accept")?.includes("image/"));

  let scenes: unknown[];
  let sceneVersion: number | undefined;
  if (typeof body.scene_id === "string") {
    const loaded = await loadStoredScenes(db, request, body);
    if ("response" in loaded) {
      return loaded.response;
    }
    scenes = loaded.scenes;
    sceneVersion = loaded.version;
  } else if (Array.isArray(body.scenes) && body.scenes.length > 0) {
    if (body.scenes.length > maxScenesPerRender) {
      return jsonError("too_many_scenes", 400, { max_scenes: maxScenesPerRender });
    }
    if (JSON.stringify(body.scenes).length > maxScenesPayloadBytes) {
      return jsonError("scenes_payload_too_large", 413, {
        max_bytes: maxScenesPayloadBytes,
      });
    }
    scenes = body.scenes;
  } else {
    return jsonError("invalid_scenes", 400);
  }

  try {
    const result = await renderScenes({
      height,
      sceneId: selectedScene,
      scenes,
      settings,
      states,
      timeoutMs: defaultRenderTimeoutMs,
      timeZone,
      width,
    });
    if (wantsJson) {
      return NextResponse.json(
        {
          errors: result.errors,
          height: result.height,
          logs: result.logs,
          png_base64: result.png.toString("base64"),
          render_ms: result.renderMs,
          state: result.state,
          ...(sceneVersion ? { version: sceneVersion } : {}),
          width: result.width,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return new NextResponse(result.png as unknown as BodyInit, {
      headers: {
        "cache-control": "no-store",
        "content-length": String(result.png.length),
        "content-type": "image/png",
        "x-render-errors": String(result.errors.length),
        "x-render-ms": String(result.renderMs),
        ...(sceneVersion ? { "x-scene-version": String(sceneVersion) } : {}),
      },
    });
  } catch (error) {
    if (error instanceof SceneRenderError) {
      const status =
        error.code === "renderer_busy"
          ? 503
          : error.code === "renderer_unavailable"
            ? 501
            : error.code === "render_timeout"
              ? 504
              : 422;
      return jsonError(error.code, status, {
        detail: error.message,
        logs: error.logs,
      });
    }
    throw error;
  }
}

function dimension(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minRenderDimension ||
    value > maxRenderDimension
  ) {
    return null;
  }
  return value;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isValidTimeZone(zone: string): boolean {
  if (zone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The scenes.json rules, verbatim: public scenes are open, private ones
// owner-only (session or the owner's linked client), pulled ones stay
// visible to their owner and to superadmins; the newest non-yanked version
// unless one is named.
async function loadStoredScenes(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<{ scenes: unknown[]; version: number } | { response: NextResponse }> {
  const sceneId = String(body.scene_id);
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return { response: jsonError("scene_not_found", 404) };
  }
  const [scene] = await db
    .select({
      accountId: storeScenes.accountId,
      id: storeScenes.id,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);
  if (!scene) {
    return { response: jsonError("scene_not_found", 404) };
  }
  if (scene.status === "pulled" && !(await canViewPulledScene(scene.accountId))) {
    return { response: jsonError("scene_pulled", 410) };
  }
  if (
    scene.visibility !== "public" &&
    !(await canAccessPrivateScene(
      db,
      request.headers.get("authorization"),
      scene.accountId,
    ))
  ) {
    return { response: jsonError("scene_not_found", 404) };
  }
  let requestedVersion: number | undefined;
  if (body.version !== undefined && body.version !== null) {
    if (
      typeof body.version !== "number" ||
      !Number.isInteger(body.version) ||
      body.version < 1
    ) {
      return { response: jsonError("invalid_version", 400) };
    }
    requestedVersion = body.version;
  }
  const [version] = await db
    .select({
      content: storeSceneVersions.content,
      objectKey: storeSceneVersions.objectKey,
      version: storeSceneVersions.version,
    })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
        requestedVersion
          ? eq(storeSceneVersions.version, requestedVersion)
          : isNull(storeSceneVersions.yankedAt),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  if (!version) {
    return { response: jsonError("version_not_found", 404) };
  }
  const content = await readBlob(version);
  if (!content) {
    return { response: jsonError("version_not_found", 404) };
  }
  const scenes = extractScenesFromZip(Buffer.from(content));
  if (!scenes || scenes.length === 0) {
    return { response: jsonError("invalid_scene_zip", 500) };
  }
  return { scenes, version: version.version };
}

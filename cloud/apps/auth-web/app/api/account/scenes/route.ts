import { and, eq, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { storeScenes } from "@frameos-cloud/db";
import { NextRequest } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import { maxPublishesPerHour, maxSceneZipBytes } from "../../../../src/lib/store";
import { publishStoreScene } from "../../../../src/lib/store-publish";

export const runtime = "nodejs";

const maxSceneNameChars = 128;
// Try "name", "name 2", … before giving up. Publishing resolves "same
// account + same name" to the EXISTING scene and appends a version — correct
// for republish, wrong for "create new" — so this route disambiguates first.
const maxNameAttempts = 20;

function zipFolderName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9 _-]/g, "_").trim();
  return (safe.length > 0 ? safe : "scene").slice(0, 64);
}

async function nameIsTaken(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  accountId: string,
  name: string,
) {
  const [clash] = await db
    .select({ id: storeScenes.id })
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.accountId, accountId),
        sql`lower(${storeScenes.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  return clash !== undefined;
}

// Create a NEW private cloud scene from raw scenes JSON — the workspace's
// "save this frame's edited scenes to my account" path, which has no ZIP to
// upload. The route builds the canonical template ZIP (the exact layout
// backend/app/api/templates.py template_zip_bytes produces) and hands it to
// publishStoreScene, so quotas, moderation, classification, slugging and
// audit all apply exactly as for an upload. Unlike upload/republish, a name
// clash creates "name 2" instead of silently versioning the other scene.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:scene-create", {
    limit: 60,
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
    "store:publish",
    { limit: maxPublishesPerHour, windowMs: 60 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const requestedName =
    typeof body.name === "string" ? body.name.trim().slice(0, maxSceneNameChars) : "";
  const name = requestedName.length > 0 ? requestedName : "Untitled scene";
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 2000)
      : undefined;

  let finalName = name;
  if (await nameIsTaken(db, session.accountId, finalName)) {
    let resolved = false;
    for (let suffix = 2; suffix <= maxNameAttempts; suffix += 1) {
      const candidate = `${name.slice(0, maxSceneNameChars - 4)} ${suffix}`;
      if (!(await nameIsTaken(db, session.accountId, candidate))) {
        finalName = candidate;
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      return jsonError("scene_name_taken", 409, { name });
    }
  }

  const folder = zipFolderName(finalName);
  const manifest = {
    name: finalName,
    ...(description ? { description } : {}),
    scenes: "./scenes.json",
  };
  const content = Buffer.from(
    zipSync({
      [`${folder}/template.json`]: strToU8(JSON.stringify(manifest, null, 2)),
      [`${folder}/scenes.json`]: strToU8(JSON.stringify(body.scenes, null, 2)),
    }),
  );
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }

  return publishStoreScene(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    content,
    description,
    name: finalName,
    visibility: "private",
  });
}

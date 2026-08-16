// Create a NEW private cloud scene from raw scenes JSON.
//
// Extracted from app/api/account/scenes/route.ts so the AI chat's save_scene
// tool runs the SAME path the workspace's "save to my account" button does:
// the canonical template ZIP, publishStoreScene's quota / moderation /
// classification / slugging / audit, and the "name 2" disambiguation that
// keeps a repeat save from silently versioning an unrelated scene. A tool
// with its own copy of this would be one refactor away from skipping
// moderation.
//
// The caller owns authentication, CSRF and rate limiting; pass an accountId
// that is already proven.

import { and, eq, sql } from "drizzle-orm";
import { createDb, storeScenes } from "@frameos-cloud/db";
import { strToU8, zipSync } from "fflate";
import { jsonError } from "./device-flow";
import { maxSceneZipBytes } from "./store";
import { publishStoreScene, type PublishActor } from "./store-publish";

type Database = ReturnType<typeof createDb>;

export const maxSceneNameChars = 128;
// Try "name", "name 2", … before giving up. Publishing resolves "same
// account + same name" to the EXISTING scene and appends a version — correct
// for republish, wrong for "create new" — so this disambiguates first.
const maxNameAttempts = 20;

function zipFolderName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9 _-]/g, "_").trim();
  return (safe.length > 0 ? safe : "scene").slice(0, 64);
}

async function nameIsTaken(db: Database, accountId: string, name: string) {
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

/** The name this save will actually use — the requested one, or "name 2",
 *  "name 3"… when the account already has scenes by that name. */
export async function availableSceneName(
  db: Database,
  accountId: string,
  requested: string,
): Promise<string | undefined> {
  const name =
    requested.trim().slice(0, maxSceneNameChars) || "Untitled scene";
  if (!(await nameIsTaken(db, accountId, name))) {
    return name;
  }
  for (let suffix = 2; suffix <= maxNameAttempts; suffix += 1) {
    const candidate = `${name.slice(0, maxSceneNameChars - 4)} ${suffix}`;
    if (!(await nameIsTaken(db, accountId, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

/** Returns publishStoreScene's response (or a jsonError) — the route hands it
 *  straight back, the AI tool reads its JSON body. */
export async function createAccountScene(
  db: Database,
  input: {
    accountId: string;
    actor: PublishActor;
    description?: string | undefined;
    name: string;
    scenes: unknown[];
  },
) {
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }
  const finalName = await availableSceneName(db, input.accountId, input.name);
  if (!finalName) {
    return jsonError("scene_name_taken", 409, { name: input.name });
  }

  const folder = zipFolderName(finalName);
  const manifest = {
    name: finalName,
    ...(input.description ? { description: input.description } : {}),
    scenes: "./scenes.json",
  };
  const content = Buffer.from(
    zipSync({
      [`${folder}/template.json`]: strToU8(JSON.stringify(manifest, null, 2)),
      [`${folder}/scenes.json`]: strToU8(JSON.stringify(input.scenes, null, 2)),
    }),
  );
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }

  return publishStoreScene(db, {
    accountId: input.accountId,
    actor: input.actor,
    content,
    ...(input.description ? { description: input.description } : {}),
    name: finalName,
    visibility: "private",
  });
}

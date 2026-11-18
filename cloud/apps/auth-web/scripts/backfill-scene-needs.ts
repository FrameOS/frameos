/* global console */
// One-off (and safe to re-run): fill store_scene_versions.needs from each
// version's own scenes with the publish-time detector (detectSceneNeeds in
// src/lib/store.ts, i.e. frontend/src/utils/sceneNeeds.ts), and
// store_scenes.needs, the copy of the latest version's the store lists by
// (docs/scene-store.md "What a scene needs"; migration 0084 added the
// columns empty). Versions are immutable and the detector is a pure function
// of their bytes, so it can run again whenever the detector learns more.
//
// DRY RUN BY DEFAULT: pass --apply to write.
//
//   DATABASE_URL=... pnpm --filter @frameos-cloud/auth-web scene:backfill-needs [--apply]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { and, eq } from "drizzle-orm";
import { createDb, storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { readBlob } from "../src/lib/blobs";
import { extractScenesFromZip } from "../src/lib/scene-title";
import { detectSceneNeeds } from "../src/lib/store";

function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env.local"), resolve(process.cwd(), "../../.env.local")]) {
    if (existsSync(candidate)) {
      try {
        (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.call(process, candidate);
      } catch {
        // tolerate a malformed line
      }
      break;
    }
  }
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((need, index) => need === b[index]);

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.slice(2).includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const db = createDb(databaseUrl);
  const versions = await db
    .select({
      content: storeSceneVersions.content,
      id: storeSceneVersions.id,
      latestVersion: storeScenes.latestVersion,
      needs: storeSceneVersions.needs,
      objectKey: storeSceneVersions.objectKey,
      riskFlags: storeSceneVersions.riskFlags,
      sceneId: storeSceneVersions.sceneId,
      sceneNeeds: storeScenes.needs,
      slug: storeScenes.slug,
      version: storeSceneVersions.version,
    })
    .from(storeSceneVersions)
    .innerJoin(storeScenes, eq(storeScenes.id, storeSceneVersions.sceneId));

  let changed = 0;
  let unreadable = 0;
  for (const row of versions) {
    const bytes = await readBlob(row);
    const scenes = bytes ? extractScenesFromZip(bytes) : undefined;
    if (!scenes) {
      unreadable += 1;
      continue;
    }
    const needs = detectSceneNeeds(scenes, row.riskFlags);
    const latest = row.version === row.latestVersion;
    if (same(needs, row.needs) && (!latest || same(needs, row.sceneNeeds))) {
      continue;
    }
    changed += 1;
    console.log(`- ${row.slug} v${row.version}${latest ? " (latest)" : ""}: ${JSON.stringify(row.needs)} -> ${JSON.stringify(needs)}`);
    if (!apply) {
      continue;
    }
    await db.update(storeSceneVersions).set({ needs }).where(eq(storeSceneVersions.id, row.id));
    if (latest) {
      await db
        .update(storeScenes)
        .set({ needs })
        .where(and(eq(storeScenes.id, row.sceneId), eq(storeScenes.latestVersion, row.version)));
    }
  }
  console.log(
    `${versions.length} versions, ${changed} ${apply ? "updated" : "would change (dry run, pass --apply)"}, ${unreadable} unreadable`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

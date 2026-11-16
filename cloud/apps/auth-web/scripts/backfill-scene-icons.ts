/* global console */
// One-off: read store_scene_versions.icon from each version's own scenes, with
// the publish-time reader (listingIconOf in src/lib/store.ts: the main scene's
// settings.icon through frontend/src/utils/sceneIcon.ts). Migration 0082 added
// the column empty; a version published before scenes had icons holds none, but
// one published after the icon shipped (#822) and before 0082 was deployed can.
// store_scenes.icon, the copy of the latest version's icon every listing reads,
// is updated with it.
//
// Versions are immutable and the reader is a pure function of their bytes, so
// this is safe to re-run.
//
// DRY RUN BY DEFAULT — pass --apply to write.
//
//   DATABASE_URL=... pnpm --filter @frameos-cloud/auth-web scene:backfill-icons [--apply]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { and, eq } from "drizzle-orm";
import { createDb, storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { readBlob } from "../src/lib/blobs";
import { extractScenesFromZip } from "../src/lib/scene-title";
import { listingIconOf } from "../src/lib/store";

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
      icon: storeSceneVersions.icon,
      id: storeSceneVersions.id,
      latestVersion: storeScenes.latestVersion,
      objectKey: storeSceneVersions.objectKey,
      sceneIcon: storeScenes.icon,
      sceneId: storeSceneVersions.sceneId,
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
      console.log(`- ${row.slug} v${row.version}: unreadable, left as ${JSON.stringify(row.icon)}`);
      continue;
    }
    const icon = listingIconOf(scenes);
    const latest = row.version === row.latestVersion;
    if (icon === row.icon && (!latest || icon === row.sceneIcon)) {
      continue;
    }
    changed += 1;
    console.log(`- ${row.slug} v${row.version}${latest ? " (latest)" : ""}: ${icon ? `${icon.length} characters` : "none"}`);
    if (!apply) {
      continue;
    }
    await db.update(storeSceneVersions).set({ icon }).where(eq(storeSceneVersions.id, row.id));
    if (latest) {
      await db
        .update(storeScenes)
        .set({ icon })
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

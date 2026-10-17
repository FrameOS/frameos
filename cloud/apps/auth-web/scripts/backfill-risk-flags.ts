/* global console */
// One-off: recompute store_scene_versions.risk_flags from each version's own
// scenes, with the publish-time detector (detectRiskFlags in src/lib/store.ts,
// i.e. frontend/src/utils/sceneAccess.ts). Versions published before the
// "files", "assets", "assets-write" and "key:<namespace>" flags existed carry
// "shell" at most, so the store shows them without "reads all files" /
// "reads assets folder" / "writes assets folder" / "uses OpenAI key" until
// this runs. store_scenes.risk_flags, the copy of the latest version's flags
// the store lists by, is updated with it.
//
// Versions are immutable and the detector is a pure function of their bytes,
// so this is safe to re-run whenever the detector learns something new.
//
// DRY RUN BY DEFAULT — pass --apply to write.
//
//   DATABASE_URL=... pnpm --filter @frameos-cloud/auth-web scene:backfill-risk-flags [--apply]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { and, eq } from "drizzle-orm";
import { createDb, storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { readBlob } from "../src/lib/blobs";
import { extractScenesFromZip } from "../src/lib/scene-title";
import { detectRiskFlags } from "../src/lib/store";

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

const sameFlags = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((flag, index) => flag === [...b].sort()[index]);

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
      objectKey: storeSceneVersions.objectKey,
      riskFlags: storeSceneVersions.riskFlags,
      sceneFlags: storeScenes.riskFlags,
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
      console.log(`- ${row.slug} v${row.version}: unreadable, left as ${JSON.stringify(row.riskFlags)}`);
      continue;
    }
    const flags = detectRiskFlags(scenes);
    const latest = row.version === row.latestVersion;
    if (sameFlags(flags, row.riskFlags) && (!latest || sameFlags(flags, row.sceneFlags))) {
      continue;
    }
    changed += 1;
    console.log(
      `- ${row.slug} v${row.version}${latest ? " (latest)" : ""}: ${JSON.stringify(row.riskFlags)} -> ${JSON.stringify(flags)}`,
    );
    if (!apply) {
      continue;
    }
    await db.update(storeSceneVersions).set({ riskFlags: flags }).where(eq(storeSceneVersions.id, row.id));
    if (latest) {
      await db
        .update(storeScenes)
        .set({ riskFlags: flags })
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

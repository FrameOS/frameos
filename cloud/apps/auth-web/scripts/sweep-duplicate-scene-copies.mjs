/* global console */
// One-off sweep for the private-scene copies the pre-#367 cloud settings save
// left behind.
//
// The bug: every settings save byte-compared the workspace's sanitized scene
// with the raw store JSON, so every assigned scene looked edited. Scenes the
// account did not own were forked into a fresh private copy per save, giving
// runs of "<name> 2", "<name> 3" … "<name> 8". The save flow no longer does
// this (#367); the copies it already made are still there.
//
// What counts as a leftover copy here — all of these, together:
//   - owned by the account, private, active,
//   - never republished (latest_version = 1, exactly one version row),
//   - never given a life of its own: no description, never published,
//     nothing but the one version the copy was born with.
//     NOT "no tags": publishing auto-classifies a new scene and assigns
//     suggested tags, so every copy carries 4-5 inherited ones while the
//     originals it was copied from all have descriptions. The absent
//     description is the discriminator; the tags are noise.
//   - named "<base> <n>" with n >= 2, where the account also has "<base>"
//     or another copy of the same run,
//   - created before --before (default: the #367 deploy).
//
// It never guesses about anything a frame is running: a copy assigned to a
// frame is REPORTED and left alone, because un-assigning it changes what a
// physical frame displays and wants a deploy afterwards. Re-point those four
// in the UI (frame → Scenes → swap the copy for the original → Save/Deploy),
// then re-run this with --apply to remove the freed copies.
//
// DRY RUN BY DEFAULT — pass --apply to delete. Deleting a scene row cascades
// to its versions, images and assignments; the objects its versions point at
// are freed by scripts/object-store-sweep.sh, which is worth running after.
//
//   DATABASE_URL=... node scripts/sweep-duplicate-scene-copies.mjs \
//     [--account=<uuid>] [--before=2026-08-18] [--apply] \
//     [--only=<uuid,uuid>] [--except=<uuid,uuid>]
import process from "node:process";
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flag = (name) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3).trim() : undefined;
};
const idList = (name) => {
  const raw = flag(name);
  if (!raw) {
    return undefined;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error(`--${name} takes scene uuids; got "${id}"`);
    }
  }
  return new Set(ids);
};

const accountId = flag("account");
if (accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) {
  throw new Error("--account takes an account uuid");
}
// The pre-#367 window. Anything created after the fix shipped is a copy the
// user made on purpose, so the default cut-off is the deploy date.
const before = flag("before") ?? "2026-08-18";
if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
  throw new Error("--before takes an ISO date (YYYY-MM-DD)");
}
const only = idList("only");
const except = idList("except");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  ...(process.env.DATABASE_SSL === "require" ||
  process.env.DATABASE_SSL === "true"
    ? { ssl: "require" }
    : {}),
});

// "Abstract Architecture 2" → { base: "Abstract Architecture", n: 2 }. The
// fork route's own "(copy N)" names are deliberately NOT matched: those came
// from someone pressing Fork, not from the save loop.
function copySuffix(name) {
  const match = /^(.+?) (\d+)$/.exec(name);
  if (!match) {
    return undefined;
  }
  const n = Number(match[2]);
  return n >= 2 && n <= 99 ? { base: match[1], n } : undefined;
}

const summary = {
  before,
  deleted: [],
  dryRun: !apply,
  keptAssigned: [],
  scanned: 0,
};

try {
  const scenes = await sql`
    select
      s.account_id,
      s.created_at,
      s.description,
      s.id,
      s.latest_version,
      s.name,
      s.slug,
      s.status,
      s.tags,
      s.visibility,
      (
        select count(*)::int from store_scene_versions v
        where v.scene_id = s.id
      ) as version_count,
      (
        select coalesce(
          json_agg(json_build_object('frameId', a.frame_id, 'frameName', f.name)),
          '[]'::json
        )
        from frame_scene_assignments a
        join frames f on f.id = a.frame_id
        where a.scene_id = s.id
      ) as assignments
    from store_scenes s
    where s.visibility = 'private'
      and s.status = 'active'
      and s.latest_version = 1
      and s.created_at < ${`${before}T00:00:00Z`}
      ${accountId ? sql`and s.account_id = ${accountId}` : sql``}
    order by s.account_id, s.name
  `;

  // Every private name the account holds, so "<base> 7" can be tied to the
  // run it belongs to: either the original "<base>" or its siblings.
  const namesByAccount = new Map();
  for (const scene of scenes) {
    if (!namesByAccount.has(scene.account_id)) {
      const owned = await sql`
        select lower(name) as name
        from store_scenes
        where account_id = ${scene.account_id}
      `;
      namesByAccount.set(
        scene.account_id,
        new Set(owned.map((row) => row.name)),
      );
    }
  }

  for (const scene of scenes) {
    summary.scanned += 1;
    if (only && !only.has(scene.id)) {
      continue;
    }
    if (except?.has(scene.id)) {
      continue;
    }
    const suffix = copySuffix(scene.name);
    if (!suffix) {
      continue;
    }
    const owned = namesByAccount.get(scene.account_id);
    const partOfARun =
      owned.has(suffix.base.toLowerCase()) ||
      owned.has(`${suffix.base} ${suffix.n - 1}`.toLowerCase()) ||
      owned.has(`${suffix.base} ${suffix.n + 1}`.toLowerCase());
    if (!partOfARun) {
      continue;
    }
    // A copy someone went on to describe or re-publish is work, not litter.
    // One version only: a second means it was saved over deliberately.
    if (scene.description || scene.version_count !== 1) {
      continue;
    }

    const record = {
      accountId: scene.account_id,
      base: suffix.base,
      createdAt: scene.created_at,
      id: scene.id,
      name: scene.name,
      slug: scene.slug,
    };

    const assignments = scene.assignments ?? [];
    if (assignments.length > 0) {
      // Left alone on purpose: this one is on a wall somewhere.
      summary.keptAssigned.push({ ...record, assignments });
      continue;
    }

    summary.deleted.push(record);
    if (apply) {
      await sql`delete from store_scenes where id = ${scene.id}`;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `${summary.deleted.length} unassigned copies ${apply ? "deleted" : "would be deleted"}, ` +
      `${summary.keptAssigned.length} assigned copies left alone.`,
  );
  if (summary.keptAssigned.length > 0) {
    console.log(
      "Assigned copies need a human: re-point each frame at the original scene " +
        "in the UI and deploy, then re-run this script.",
    );
  }
  if (!apply) {
    console.log("Dry run — nothing was changed. Re-run with --apply to write.");
  } else if (summary.deleted.length > 0) {
    console.log(
      "Run scripts/object-store-sweep.sh afterwards to free the orphaned objects.",
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}

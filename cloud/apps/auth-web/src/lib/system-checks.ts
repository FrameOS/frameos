// Health for the /admin panel, in two flavours:
//
//   runSystemChecks()  configuration — which environment variables are set
//                      and what stops working without them. Presence only,
//                      never values. Synchronous and free.
//   runLiveChecks()    the things a set env var does not prove: that Postgres
//                      answers and that Postmark will actually deliver.
//                      Talks to those services, so it is async and slow-ish.
//
// The split matters because the two most expensive outages this service can
// have — a dead database and silently undelivered mail — both look perfectly
// healthy to a presence check.

import { and, gt, isNotNull, sql } from "drizzle-orm";
import { createDb, frameAssetFiles } from "@frameos-cloud/db";
import { checkEmailDelivery } from "./email";
import { hasDatabaseUrl } from "./env";
import { objectStore } from "./object-store";
import { getTurnstileSiteKey } from "./turnstile";

export type SystemCheck = {
  configured: boolean;
  detail: string;
  name: string;
  required: boolean;
};

function isSet(name: string) {
  return Boolean(process.env[name]?.trim());
}

export function runSystemChecks(): SystemCheck[] {
  const splitOrigins =
    new Set(
      [
        process.env.FRAMEOS_ACCOUNT_APP_URL,
        process.env.FRAMEOS_CLOUD_APP_URL,
        process.env.FRAMEOS_SCENES_APP_URL,
      ]
        .map((value) => value?.trim())
        .filter(Boolean),
    ).size > 1;

  return [
    {
      configured: isSet("DATABASE_URL"),
      detail: "Postgres connection — nothing works without it.",
      name: "DATABASE_URL",
      required: true,
    },
    {
      configured: isSet("SESSION_SECRET"),
      detail: "Signs sessions and derived tokens.",
      name: "SESSION_SECRET",
      required: true,
    },
    {
      configured: isSet("FRAMEOS_CLOUD_ENCRYPTION_KEY"),
      detail: "Encrypts stored secrets (link tokens, backups).",
      name: "FRAMEOS_CLOUD_ENCRYPTION_KEY",
      required: true,
    },
    {
      configured: isSet("FRAMEOS_CLOUD_APP_URL"),
      detail: "Public login/auth URL used for OAuth, emails, and handoffs.",
      name: "FRAMEOS_CLOUD_APP_URL",
      required: true,
    },
    {
      configured: isSet("FRAMEOS_ACCOUNT_APP_URL"),
      detail: "Public URL used for account, device, and admin pages.",
      name: "FRAMEOS_ACCOUNT_APP_URL",
      required: true,
    },
    {
      configured: isSet("FRAMEOS_SCENES_APP_URL"),
      detail:
        "Public Scene Store URL; use the cloud URL locally to keep one port.",
      name: "FRAMEOS_SCENES_APP_URL",
      required: true,
    },
    {
      configured: !splitOrigins || isSet("FRAMEOS_SESSION_COOKIE_DOMAIN"),
      detail:
        "Parent cookie domain that shares login between the cloud, account, and scenes origins.",
      name: "FRAMEOS_SESSION_COOKIE_DOMAIN",
      required: splitOrigins,
    },
    {
      configured: isSet("GOOGLE_CLIENT_ID") && isSet("GOOGLE_CLIENT_SECRET"),
      detail: "Google sign-in; without it only email/password works.",
      name: "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET",
      required: false,
    },
    {
      configured:
        isSet("POSTMARK_SERVER_TOKEN") && isSet("POSTMARK_FROM_EMAIL"),
      detail:
        "Outgoing email (verification, password resets); unsent mail is logged to the console instead.",
      name: "POSTMARK_SERVER_TOKEN + POSTMARK_FROM_EMAIL",
      required: false,
    },
    {
      configured: isSet("OPENAI_API_KEY"),
      detail:
        "Moderation of store names, descriptions, and images; unmoderated when unset.",
      name: "OPENAI_API_KEY",
      required: false,
    },
    {
      configured: isSet("DISCORD_REPORTS_WEBHOOK_URL"),
      detail: "Discord heads-up when a scene is reported.",
      name: "DISCORD_REPORTS_WEBHOOK_URL",
      required: false,
    },
    {
      configured: isSet("NEXT_PUBLIC_POSTHOG_KEY"),
      detail:
        "PostHog analytics AND error tracking (browser exceptions, server-side reportError, signup capture).",
      name: "NEXT_PUBLIC_POSTHOG_KEY",
      required: false,
    },
    {
      configured:
        isSet("NEXT_PUBLIC_TURNSTILE_SITE_KEY") && isSet("TURNSTILE_SECRET_KEY"),
      detail:
        "Cloudflare Turnstile on signup and password reset; without it the Postgres rate limiter is the only gate.",
      name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY",
      required: false,
    },
    {
      configured:
        isSet("R2_CLOUD_ENDPOINT") &&
        isSet("R2_CLOUD_ACCESS_KEY_ID") &&
        isSet("R2_CLOUD_SECRET_ACCESS_KEY"),
      detail:
        "Object storage for scene zips, previews and frame snapshots. Without all three the app falls back to a directory on this host — correct in development, almost certainly wrong in production. The same three belong in the frame-hub's environment.",
      name: "R2_CLOUD_ENDPOINT + R2_CLOUD_ACCESS_KEY_ID + R2_CLOUD_SECRET_ACCESS_KEY",
      required: false,
    },
    {
      configured: isSet("FRAMEOS_LEGAL_ENTITY_NAME"),
      detail:
        "Operator identity on /legal/imprint, /legal/terms, and /legal/privacy. Required by EU law before broad signup.",
      name: "FRAMEOS_LEGAL_ENTITY_* (see legal.ts)",
      required: true,
    },
  ];
}

export type LiveCheck = {
  detail: string;
  name: string;
  state: "ok" | "warning" | "failing" | "not_configured";
};

async function checkDatabaseLive(): Promise<LiveCheck> {
  if (!hasDatabaseUrl()) {
    return {
      detail: "DATABASE_URL is not set.",
      name: "Postgres",
      state: "failing",
    };
  }
  const startedAt = Date.now();
  try {
    await createDb().execute(sql`select 1`);
    return {
      detail: `Answered select 1 in ${Date.now() - startedAt} ms.`,
      name: "Postgres",
      state: "ok",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "unknown error",
      name: "Postgres",
      state: "failing",
    };
  }
}

// Not a probe of a remote service but of THIS BUILD: the site key is a
// NEXT_PUBLIC_ value inlined when the bundle was compiled, and production
// bundles are built on a developer machine and streamed to the server. So
// "the server's env file has both keys" does not mean the running app has
// both — and the presence check above cannot tell the difference. This can.
function checkTurnstileLive(): LiveCheck {
  const siteKeyInBundle = Boolean(getTurnstileSiteKey());
  const secretAtRuntime = Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());

  if (!siteKeyInBundle && !secretAtRuntime) {
    return {
      detail: "Not configured; the Postgres rate limiter is the only gate.",
      name: "Turnstile (signup abuse gate)",
      state: "not_configured",
    };
  }
  if (siteKeyInBundle && secretAtRuntime) {
    return {
      detail: "Site key is baked into this build and the secret is present.",
      name: "Turnstile (signup abuse gate)",
      state: "ok",
    };
  }
  if (!siteKeyInBundle) {
    return {
      detail:
        "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY was missing when this bundle was BUILT — no widget renders, so Turnstile is disabled to avoid rejecting every signup. Set the site key where the build runs and redeploy.",
      name: "Turnstile (signup abuse gate)",
      state: "failing",
    };
  }
  return {
    detail:
      "Site key is in the build but TURNSTILE_SECRET_KEY is missing at runtime, so the widget's answer is never checked.",
    name: "Turnstile (signup abuse gate)",
    state: "failing",
  };
}

// Credentials that parse are not credentials that work: a wrong endpoint, a
// bucket that does not exist and a revoked key all look identical to a
// presence check, and the first thing to notice would otherwise be a publish
// failing or a preview 404ing. So write a small object, read it back, and
// delete it.
const objectStoreProbeKey = "health/object-store-probe";

async function checkObjectStoreLive(): Promise<LiveCheck> {
  const store = objectStore();
  const name = "Object storage (blobs)";
  const startedAt = Date.now();
  const payload = Buffer.from(`frameos-cloud probe ${startedAt}`);
  try {
    await store.put(objectStoreProbeKey, payload, "text/plain");
    const read = await store.get(objectStoreProbeKey);
    await store.delete(objectStoreProbeKey);
    if (!read || !read.equals(payload)) {
      return {
        detail: `Wrote a probe object through the ${store.driver} driver and read back ${
          read ? "different bytes" : "nothing"
        }.`,
        name,
        state: "failing",
      };
    }
    const elapsed = Date.now() - startedAt;
    if (store.driver === "fs") {
      // Not an error — it is the development default — but on a production
      // host it means blobs are landing on the app server's local disk, where
      // no backup will find them.
      return {
        detail: `Filesystem driver: wrote, read and deleted a probe in ${elapsed} ms. Correct in development; in production it means R2_CLOUD_* is missing and blobs are on this host's disk.`,
        name,
        state: "warning",
      };
    }
    return {
      detail: `Wrote, read and deleted a probe object in ${elapsed} ms.`,
      name,
      state: "ok",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "unknown error",
      name,
      state: "failing",
    };
  }
}

// The frame hub writes device snapshots through the same code auth-web reads
// them with, from its OWN environment file — so it is entirely possible for
// auth-web to be reading R2 while the hub keeps writing bytes into Postgres.
// Nothing errors; previews just go blank for frames that re-rendered. The
// tell is a frame_asset_files row written RECENTLY that still carries its
// bytes: no row should, since nothing writes bytes into that column any more.
async function checkHubObjectStoreLive(): Promise<LiveCheck> {
  const name = "Frame hub object storage";
  if (!hasDatabaseUrl()) {
    return { detail: "DATABASE_URL is not set.", name, state: "failing" };
  }
  try {
    const [row] = await createDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(frameAssetFiles)
      .where(
        and(
          isNotNull(frameAssetFiles.content),
          gt(frameAssetFiles.updatedAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    const count = Number(row?.count ?? 0);
    if (count === 0) {
      return {
        detail: "No recently written snapshot is holding its bytes in Postgres.",
        name,
        state: "ok",
      };
    }
    return {
      detail: `${count} snapshot row(s) written in the last hour still hold their bytes in Postgres — the hub is not using the object store. Put R2_CLOUD_* in /etc/frameos-cloud/frame-hub.env and restart it. (Expected briefly during a rolling deploy.)`,
      name,
      state: "warning",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "unknown error",
      name,
      state: "failing",
    };
  }
}

// Every remote probe in parallel; each already resolves to a result rather
// than throwing, so one failing service cannot blank the whole panel.
export async function runLiveChecks(): Promise<LiveCheck[]> {
  const [database, email, objects, hubObjects] = await Promise.all([
    checkDatabaseLive(),
    checkEmailDelivery(),
    checkObjectStoreLive(),
    checkHubObjectStoreLive(),
  ]);
  return [
    database,
    { ...email, name: "Postmark (email delivery)" },
    objects,
    hubObjects,
    checkTurnstileLive(),
  ];
}

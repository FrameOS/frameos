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

import { sql } from "drizzle-orm";
import { createDb } from "@frameos-cloud/db";
import { checkEmailDelivery } from "./email";
import { hasDatabaseUrl } from "./env";

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
      configured: isSet("FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL"),
      detail: "Discord heads-up when a new account signs up.",
      name: "FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL",
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

// Both probes in parallel; each already resolves to a result rather than
// throwing, so one failing service cannot blank the whole panel.
export async function runLiveChecks(): Promise<LiveCheck[]> {
  const [database, email] = await Promise.all([
    checkDatabaseLive(),
    checkEmailDelivery(),
  ]);
  return [database, { ...email, name: "Postmark (email delivery)" }];
}

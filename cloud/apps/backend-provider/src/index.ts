// The self-hosted backend's provider sidecar: FrameOS Cloud's frame hub,
// unmodified, next to the backend in its container (docs/convergence-todo.md
// item 7, Stage 1, option B), on the sidecar's own Postgres with the cloud's
// schema. Frames the backend enrolled dial the backend's /api/frames/ws, which
// relays to this hub; the backend queues verbs and follows the frames through
// the bridge (src/bridge.ts).
//
// Env (the backend's docker-entrypoint.sh sets every one of them):
//   DATABASE_URL                     the sidecar's Postgres (never the cloud's)
//   SESSION_SECRET                   the hub's session signing secret
//   FRAMEOS_PROVIDER_BRIDGE_SECRET   what the backend presents to the bridge
//   FRAME_HUB_PORT                   the hub (default 3100)
//   FRAMEOS_PROVIDER_BRIDGE_PORT     the bridge (default 3101, 127.0.0.1 only)
//   FRAMEOS_OBJECT_STORE_DIR         where asset files the frames send are kept
//   FRAMEOS_PROVIDER_MIGRATIONS_DIR  the cloud's drizzle/*.sql (bundled copy)
//
// Unlike the cloud's hub entry point this never reads a .env.local: in a
// developer checkout that file is the CLOUD's, and its DATABASE_URL is the
// cloud's development database.
import { startFrameHub } from "../../frame-hub/src/hub";
import { startBridge } from "./bridge";
import { applyMigrations, defaultMigrationsDir } from "./migrate";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`backend-provider: ${name} is required`);
    process.exit(1);
  }
  return value;
}

function portEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= 0 && value < 65536 ? value : fallback;
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  requireEnv("SESSION_SECRET");
  const secret = requireEnv("FRAMEOS_PROVIDER_BRIDGE_SECRET");
  const applied = await applyMigrations(databaseUrl, defaultMigrationsDir(), (name) =>
    console.log(`backend-provider: applied ${name}`),
  );
  console.log(`backend-provider: schema up to date (${applied.length} new migrations)`);

  const hub = await startFrameHub({ databaseUrl, port: portEnv("FRAME_HUB_PORT", 3100) });
  const bridge = await startBridge({
    databaseUrl,
    host: process.env.FRAMEOS_PROVIDER_BRIDGE_HOST?.trim() || "127.0.0.1",
    port: portEnv("FRAMEOS_PROVIDER_BRIDGE_PORT", 3101),
    secret,
  });
  console.log(`backend-provider: hub on :${hub.port}, bridge on :${bridge.port}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`backend-provider: ${signal}, stopping`);
    Promise.all([hub.close(), bridge.close()])
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("backend-provider: shutdown failed", error);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("backend-provider: start failed", error);
  process.exit(1);
});

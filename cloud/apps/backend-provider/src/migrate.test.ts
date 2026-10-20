import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runsWithoutTransaction } from "./migrate";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/drizzle");

// The same opt-out rule as cloud/scripts/db-migrate.sh: only an exact first line.
describe("runsWithoutTransaction", () => {
  it("takes the opt-out on the first line only", () => {
    expect(runsWithoutTransaction("-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);")).toBe(true);
    expect(runsWithoutTransaction("--migrate:no-transaction")).toBe(true);
    expect(runsWithoutTransaction("CREATE TABLE x ();\n-- migrate: no-transaction")).toBe(false);
    expect(runsWithoutTransaction("-- migrate: no-transaction, please")).toBe(false);
  });

  it("finds no file that needs it today (every migration is one transaction)", () => {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(60);
    for (const name of files) {
      expect(runsWithoutTransaction(readFileSync(path.join(migrationsDir, name), "utf8")), name).toBe(false);
    }
  });
});

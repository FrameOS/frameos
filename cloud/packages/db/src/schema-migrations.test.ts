import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";

// schema.ts must describe every index and unique constraint the migrations
// created — and nothing they did not. drizzle-kit diffs the file against the
// database, so an index that exists only in SQL would be "generated" away on
// the first `drizzle-kit generate`, and one that exists only in the file
// would silently never be created. Both directions are checked here from the
// SQL text itself: no database needed, and it runs with the unit tests.

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

function stripComments(sql: string) {
  return sql.replace(/--[^\n]*/g, "");
}

// The CREATE INDEX names still standing after every DROP INDEX, plus the
// unique constraints declared as CONSTRAINT "…" UNIQUE or as a column's
// inline UNIQUE (which Postgres names <table>_<column>_key).
function indexesAndUniquesInMigrations() {
  const created = new Set<string>();
  const dropped = new Set<string>();
  const uniques = new Set<string>();
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(50);
  for (const file of files) {
    const sql = stripComments(readFileSync(path.join(migrationsDir, file), "utf8"));
    for (const match of sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi,
    )) {
      created.add(match[1]!);
    }
    for (const match of sql.matchAll(
      /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi,
    )) {
      dropped.add(match[1]!);
    }
    for (const match of sql.matchAll(
      /CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+UNIQUE/gi,
    )) {
      uniques.add(match[1]!);
    }
    for (const table of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s*\(([\s\S]*?)\);/gi,
    )) {
      for (const column of table[2]!.matchAll(
        /^\s*"?([A-Za-z0-9_]+)"?\s+[A-Za-z0-9_ ()]+?\bUNIQUE\b/gim,
      )) {
        if (column[1]!.toUpperCase() !== "CONSTRAINT") {
          uniques.add(`${table[1]}_${column[1]}_key`);
        }
      }
    }
  }
  for (const name of dropped) {
    created.delete(name);
  }
  return { indexes: created, uniques };
}

function indexesAndUniquesInSchema() {
  const indexes = new Set<string>();
  const uniques = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) {
      continue;
    }
    const config = getTableConfig(value);
    for (const index of config.indexes) {
      if (index.config.name) {
        indexes.add(index.config.name);
      }
    }
    for (const constraint of config.uniqueConstraints) {
      if (constraint.name) {
        uniques.add(constraint.name);
      }
    }
  }
  return { indexes, uniques };
}

function difference(a: Set<string>, b: Set<string>) {
  return [...a].filter((name) => !b.has(name)).sort();
}

describe("schema.ts against drizzle/*.sql", () => {
  const migrated = indexesAndUniquesInMigrations();
  const declared = indexesAndUniquesInSchema();

  it("declares every index the migrations created", () => {
    expect(difference(migrated.indexes, declared.indexes)).toEqual([]);
  });

  it("declares no index the migrations never created", () => {
    expect(difference(declared.indexes, migrated.indexes)).toEqual([]);
  });

  it("declares every unique constraint the migrations created", () => {
    expect(difference(migrated.uniques, declared.uniques)).toEqual([]);
    expect(difference(declared.uniques, migrated.uniques)).toEqual([]);
  });
});

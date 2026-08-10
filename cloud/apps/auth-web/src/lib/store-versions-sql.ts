import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { frameosVersionComponents, frameosVersionKey } from "./store-versions";

// The SQL half of frameosVersionSatisfies: keep rows whose declared minimum
// FrameOS version is <= `target`. Rows with a null/blank/non-numeric minimum
// are kept, mirroring the "assume it runs anywhere" rule in store-versions.ts.
//
// The column is turned into the same zero-padded numeric key the TypeScript
// comparator builds, so a paginated listing and the JSON repository always
// agree. numeric[] (not int[]) because a hand-edited manifest can carry
// components far outside int range; Postgres compares arrays element by
// element, which is exactly the comparison we want.
//
// This lives in its own module because store-versions.ts is imported by client
// components — drizzle must not follow it into the browser bundle.
export function frameosVersionSatisfiesSql(
  column: PgColumn,
  target: string,
): SQL {
  const key = frameosVersionKey(target);
  if (!key) {
    return sql`true`;
  }
  // Safe to inline: every element came out of frameosVersionKey as a number.
  const targetArray = sql.raw(`array[${key.join(", ")}]::numeric[]`);
  const padding = sql.raw(
    `array[${new Array(frameosVersionComponents).fill("'0'").join(", ")}]`,
  );
  const slice = sql.raw(`[1:${frameosVersionComponents}]`);
  return sql`(
    ${column} is null
    or btrim(${column}) !~ '^[0-9]'
    or ((
      string_to_array(
        substring(btrim(${column}) from '^[0-9]+(?:\\.[0-9]+)*'),
        '.'
      ) || ${padding}
    )${slice}::numeric[] <= ${targetArray})
  )`;
}

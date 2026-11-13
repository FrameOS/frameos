// The backend scopes most `/api/...` paths to a project; the SPA's
// apiFetch and the iOS app's APIClient decide which with the same rule,
// pinned by docs/api-path-fixtures.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProjectScopedApiPath } from "../../../../../../frontend/src/utils/projectApi";

const fixtures = JSON.parse(readFileSync(join(__dirname, "../../../../../../docs/api-path-fixtures.json"), "utf8")) as {
  cases: { path: string; scoped: boolean }[];
};

describe("docs/api-path-fixtures.json", () => {
  for (const kase of fixtures.cases) {
    it(`${kase.path} ${kase.scoped ? "is" : "is not"} project-scoped`, () => {
      expect(isProjectScopedApiPath(kase.path)).toBe(kase.scoped);
    });
  }
});

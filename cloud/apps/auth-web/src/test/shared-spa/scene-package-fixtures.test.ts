// A scene as files (docs/scene-packages.md): frontend/src/utils/scenePackage.ts
// replays docs/scene-package-fixtures.json, as the backend's
// app/utils/scene_package.py and the runtime's scene_package.nim do.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PackageFiles,
  type PackageScene,
  ScenePackageError,
  sceneFolderNames,
  sceneFromPackageFiles,
  scenePackageFiles,
  setFromPackageFiles,
  setPackageFiles,
} from "../../../../../../frontend/src/utils/scenePackage";

type FixtureFiles = Record<string, unknown>;
const fixtures = JSON.parse(readFileSync(join(__dirname, "../../../../../../docs/scene-package-fixtures.json"), "utf8")) as {
  scenes: { name: string; scene: PackageScene; withoutTests?: boolean; files: FixtureFiles }[];
  sets: { name: string; scenes: PackageScene[]; manifest: Record<string, unknown>; files: FixtureFiles }[];
  folderNames: { scenes: PackageScene[]; folders: string[] }[];
  reads: { name: string; files: PackageFiles; scenes: PackageScene[]; manifest: Record<string, unknown> | null }[];
  refusals: { name: string; files: PackageFiles; code: string }[];
};

function isJsonFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return (name === "scene.json" || name === "template.json") && !parts.slice(0, -1).includes("apps");
}

function parsed(files: PackageFiles): FixtureFiles {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path, isJsonFile(path) ? JSON.parse(text) : text]));
}

function texts(files: FixtureFiles): PackageFiles {
  return Object.fromEntries(
    Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? value : JSON.stringify(value)]),
  );
}

describe("docs/scene-package-fixtures.json", () => {
  for (const kase of fixtures.scenes) {
    it(`scene: ${kase.name}`, () => {
      const files = scenePackageFiles(structuredClone(kase.scene), { withoutTests: kase.withoutTests });
      expect(parsed(files)).toEqual(kase.files);
      expect(Object.keys(files)[0]).toBe("scene.json");
      if (!kase.withoutTests) {
        expect(sceneFromPackageFiles(texts(kase.files))).toEqual(kase.scene);
      }
    });
  }
  for (const kase of fixtures.sets) {
    it(`set: ${kase.name}`, () => {
      const files = setPackageFiles(structuredClone(kase.scenes), kase.manifest);
      expect(parsed(files)).toEqual(kase.files);
      const read = setFromPackageFiles(texts(kase.files));
      expect(read.scenes).toEqual(kase.scenes);
      expect(read.manifest).toEqual(kase.files["template.json"]);
    });
  }
  for (const kase of fixtures.folderNames) {
    it(`folders: ${kase.folders.join(", ")}`, () => {
      expect(sceneFolderNames(kase.scenes)).toEqual(kase.folders);
    });
  }
  for (const kase of fixtures.reads) {
    it(`read: ${kase.name}`, () => {
      const read = setFromPackageFiles(kase.files);
      expect(read.scenes).toEqual(kase.scenes);
      expect(read.manifest).toEqual(kase.manifest);
    });
  }
  for (const kase of fixtures.refusals) {
    it(`refused: ${kase.name}`, () => {
      let error: unknown = null;
      try {
        setFromPackageFiles(kase.files);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ScenePackageError);
      expect((error as ScenePackageError).code).toBe(kase.code);
    });
  }
});

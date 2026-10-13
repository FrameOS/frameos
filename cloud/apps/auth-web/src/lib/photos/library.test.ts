import { describe, expect, it } from "vitest";
import { checkPhotoScanning } from "../system-checks";
import { describePhotoChildren, isPhotoShareToken, newPhotoShareToken } from "./library";

const at = new Date("2026-10-01T12:00:00Z");

function folder(path: string) {
  return {
    contentType: null,
    createdAt: at,
    height: null,
    kind: "folder",
    path,
    sizeBytes: 0,
    status: "ready",
    width: null,
  };
}

function file(path: string, sizeBytes = 100, contentType = "image/jpeg", status = "ready") {
  return {
    contentType,
    createdAt: at,
    height: 30,
    kind: "file",
    path,
    sizeBytes,
    status,
    width: 40,
  };
}

describe("describePhotoChildren", () => {
  const rows = [
    folder("Summer"),
    file("Summer/b.jpg", 10),
    file("Summer/A 10.jpg", 20),
    file("Summer/A 9.jpg", 30, "image/png", "blocked"),
    folder("Summer/Beach"),
    file("Summer/Beach/x.jpg", 5),
    folder("Empty"),
    folder("Nested"),
    folder("Nested/z"),
    folder("Nested/a"),
    file("Nested/z/1.jpg", 1),
    file("Nested/a/2.jpg", 2),
    file("root.jpg", 7),
  ];

  it("lists folders first, then files, by name", () => {
    expect(describePhotoChildren("", rows).map((entry) => entry.path)).toEqual([
      "Empty",
      "Nested",
      "Summer",
      "root.jpg",
    ]);
  });

  it("gives folders their items, files, size and cover", () => {
    const entries = describePhotoChildren("", rows);
    const summer = entries.find((entry) => entry.path === "Summer");
    expect(summer).toMatchObject({
      content_type: null,
      files: 4,
      height: null,
      items: 4,
      kind: "folder",
      name: "Summer",
      size: 65,
      width: null,
    });
    // The first ready image among the direct children, by name: the blocked
    // "A 9.jpg" sorts first but is not shown.
    expect(summer?.cover).toBe("Summer/A 10.jpg");
    // No direct image: the first one a level down, folders by name.
    expect(entries.find((entry) => entry.path === "Nested")?.cover).toBe("Nested/a/2.jpg");
    expect(entries.find((entry) => entry.path === "Empty")).toMatchObject({
      cover: null,
      files: 0,
      items: 0,
      size: 0,
    });
  });

  it("describes files in the contract's shape", () => {
    const rootFile = describePhotoChildren("", rows).find((entry) => entry.path === "root.jpg");
    expect(rootFile).toEqual({
      content_type: "image/jpeg",
      height: 30,
      kind: "file",
      mtime: Math.floor(at.getTime() / 1000),
      name: "root.jpg",
      path: "root.jpg",
      size: 7,
      status: "ready",
      width: 40,
    });
  });

  it("lists a subfolder's children with natural order", () => {
    expect(describePhotoChildren("Summer", rows).map((entry) => entry.name)).toEqual([
      "Beach",
      "A 9.jpg",
      "A 10.jpg",
      "b.jpg",
    ]);
  });
});

describe("share tokens", () => {
  it("are pk_ plus at least 32 URL-safe characters", () => {
    const token = newPhotoShareToken();
    expect(token).toMatch(/^pk_[A-Za-z0-9_-]{32}$/);
    expect(isPhotoShareToken(token)).toBe(true);
    expect(newPhotoShareToken()).not.toBe(token);
    expect(isPhotoShareToken("pk_short")).toBe(false);
    expect(isPhotoShareToken(`xx_${"a".repeat(32)}`)).toBe(false);
  });
});

describe("the photo scanning check", () => {
  it("warns while the hash list is the only scanner", () => {
    expect(checkPhotoScanning({}).state).toBe("warning");
    expect(checkPhotoScanning({ PHOTODNA_SUBSCRIPTION_KEY: "k" })).toMatchObject({
      detail: "Every photo upload passes: hash_list, photodna.",
      state: "ok",
    });
  });
});

// The frame form's assets-path rule, the same one the Linux runtime applies
// when it loads frame.json (frameos/src/frameos/config.nim, assetsPathAllowed)
// and the backend on save (backend/app/utils/assets_path.py).
import { describe, expect, it } from "vitest";
import {
  ASSETS_PATH_RULE,
  assetsPathAllowed,
  assetsPathError,
} from "../../../../../../frontend/src/utils/assetsPath";

describe("assetsPathAllowed", () => {
  it("takes the asset roots and folders inside them", () => {
    for (const path of ["/srv/assets", "/srv/assets/", "/srv/assets/photos", "/mnt", "/mnt/usb", "/media/pi/USB"]) {
      expect(assetsPathAllowed(path), path).toBe(true);
    }
  });

  it("refuses the runtime's own folders, relative paths and anything that climbs out", () => {
    for (const path of [
      "",
      "/",
      "/srv",
      "/srv/frameos/state",
      "/srv/assets/../frameos",
      "/srv/assets/./x",
      "/srv//assets",
      "/srv/assetsx",
      "/mntx",
      "state",
      "./tmp",
    ]) {
      expect(assetsPathAllowed(path), path).toBe(false);
    }
  });
});

describe("assetsPathError", () => {
  it("says the rule for a refused path and nothing for an empty one", () => {
    expect(assetsPathError("/srv/frameos/state")).toBe(ASSETS_PATH_RULE);
    expect(assetsPathError("/mnt/photos")).toBeUndefined();
    expect(assetsPathError("")).toBeUndefined();
    expect(assetsPathError(undefined)).toBeUndefined();
  });

  it("leaves the folder a frame already has alone", () => {
    expect(assetsPathError("/home/pi/assets/", "/home/pi/assets")).toBeUndefined();
    expect(assetsPathError("/home/pi/elsewhere", "/home/pi/assets")).toBe(ASSETS_PATH_RULE);
  });
});

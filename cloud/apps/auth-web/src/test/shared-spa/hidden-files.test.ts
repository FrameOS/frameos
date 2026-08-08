import { describe, expect, it } from "vitest";
import {
  isHiddenName,
  isHiddenOrJunkAssetPath,
  isHiddenOrJunkFileName,
  isJunkDirName,
} from "../../../../../../frontend/src/utils/hiddenFiles";

// Mirrors frameos/src/frameos/tests/test_paths_junk.nim — the device-side Nim
// rules in frameos/src/frameos/utils/paths.nim must stay in sync with these.
describe("hidden and junk file rules", () => {
  it("treats AppleDouble sidecars and dotfiles as junk", () => {
    expect(isHiddenOrJunkFileName("._IMG_1234.jpg")).toBe(true);
    expect(isHiddenOrJunkFileName(".DS_Store")).toBe(true);
    expect(isHiddenOrJunkFileName(".hidden")).toBe(true);
    expect(isHiddenName("._IMG_1234.jpg")).toBe(true);
  });

  it("treats Windows droppings as junk regardless of case", () => {
    expect(isHiddenOrJunkFileName("Thumbs.db")).toBe(true);
    expect(isHiddenOrJunkFileName("thumbs.db")).toBe(true);
    expect(isHiddenOrJunkFileName("THUMBS.DB")).toBe(true);
    expect(isHiddenOrJunkFileName("ehthumbs.db")).toBe(true);
    expect(isHiddenOrJunkFileName("Desktop.ini")).toBe(true);
    expect(isHiddenOrJunkFileName("shortcut.lnk")).toBe(true);
  });

  it("treats temporary and partial downloads as junk", () => {
    expect(isHiddenOrJunkFileName("scratch.tmp")).toBe(true);
    expect(isHiddenOrJunkFileName("scratch.TEMP")).toBe(true);
    expect(isHiddenOrJunkFileName("movie.mp4.part")).toBe(true);
    expect(isHiddenOrJunkFileName("half.jpg.crdownload")).toBe(true);
    expect(isHiddenOrJunkFileName("half.jpg.download")).toBe(true);
    expect(isHiddenOrJunkFileName("notes.txt~")).toBe(true);
  });

  it("only counts the trailing extension", () => {
    expect(isHiddenOrJunkFileName("photo.tmp.jpg")).toBe(false);
    expect(isHiddenOrJunkFileName("desktop.ini.jpg")).toBe(false);
    expect(isHiddenOrJunkFileName("thumbs.db.png")).toBe(false);
    expect(isHiddenOrJunkFileName("IMG.jpg")).toBe(false);
    expect(isHiddenOrJunkFileName("My Vacation (2024).JPEG")).toBe(false);
    expect(isHiddenOrJunkFileName("temp.jpg")).toBe(false);
  });

  it("prunes junk directories", () => {
    expect(isJunkDirName("@eaDir")).toBe(true);
    expect(isJunkDirName("@EADIR")).toBe(true);
    expect(isJunkDirName("__MACOSX")).toBe(true);
    expect(isJunkDirName("$RECYCLE.BIN")).toBe(true);
    expect(isJunkDirName("RECYCLER")).toBe(true);
    expect(isJunkDirName("System Volume Information")).toBe(true);
    expect(isJunkDirName(".Trashes")).toBe(true);
    expect(isJunkDirName(".Spotlight-V100")).toBe(true);
    expect(isJunkDirName(".fseventsd")).toBe(true);
    expect(isJunkDirName("vacation")).toBe(false);
    expect(isJunkDirName("2024-08 Norway")).toBe(false);
  });

  it("judges parent components as directories and the leaf as a file", () => {
    expect(isHiddenOrJunkAssetPath("./@eaDir/IMG.jpg")).toBe(true);
    expect(isHiddenOrJunkAssetPath("./vacation/@eaDir/beach.png")).toBe(true);
    expect(isHiddenOrJunkAssetPath("./vacation/._beach.png")).toBe(true);
    expect(isHiddenOrJunkAssetPath("__MACOSX\\IMG.jpg")).toBe(true);
    expect(isHiddenOrJunkAssetPath("./vacation/beach.png")).toBe(false);
    expect(isHiddenOrJunkAssetPath("./vacation/photo.tmp.jpg")).toBe(false);
    // The assets root itself is never junk.
    expect(isHiddenOrJunkAssetPath(".")).toBe(false);
    expect(isHiddenOrJunkAssetPath("")).toBe(false);
  });
});

import std/[algorithm, os, strutils, unittest]

import ../utils/paths

proc makeTree(root: string) =
  removeDir(root)
  createDir(root)
  createDir(root / "vacation")
  createDir(root / "@eaDir")
  createDir(root / "vacation" / "@eaDir")
  createDir(root / "__MACOSX")
  createDir(root / "System Volume Information")
  createDir(root / ".Trashes")
  createDir(root / ".thumbs")

  writeFile(root / "IMG.jpg", "x")
  writeFile(root / "photo.tmp.jpg", "x")
  writeFile(root / "._IMG.jpg", "x")
  writeFile(root / ".DS_Store", "x")
  writeFile(root / "Thumbs.db", "x")
  writeFile(root / "THUMBS.DB", "x") # case-insensitive on macOS: same file
  writeFile(root / "ehthumbs.db", "x")
  writeFile(root / "Desktop.ini", "x")
  writeFile(root / "half.jpg.crdownload", "x")
  writeFile(root / "notes.txt~", "x")
  writeFile(root / "shortcut.lnk", "x")
  writeFile(root / "scratch.tmp", "x")
  writeFile(root / "vacation" / "beach.png", "x")
  writeFile(root / "vacation" / "._beach.png", "x")
  writeFile(root / "vacation" / "@eaDir" / "beach.png", "x")
  writeFile(root / "@eaDir" / "IMG.jpg", "x")
  writeFile(root / "__MACOSX" / "IMG.jpg", "x")
  writeFile(root / "System Volume Information" / "IndexerVolumeGuid", "x")
  writeFile(root / ".Trashes" / "IMG.jpg", "x")
  writeFile(root / ".thumbs" / "abc.320x320.jpg", "x")

suite "hidden and junk file filtering":
  test "AppleDouble sidecars and dotfiles are junk":
    check isHiddenOrJunkFile("._IMG_1234.jpg")
    check isHiddenOrJunkFile(".DS_Store")
    check isHiddenOrJunkFile(".hidden")
    check isHiddenName("._IMG_1234.jpg")

  test "Windows droppings are junk regardless of case":
    check isHiddenOrJunkFile("Thumbs.db")
    check isHiddenOrJunkFile("thumbs.db")
    check isHiddenOrJunkFile("THUMBS.DB")
    check isHiddenOrJunkFile("ehthumbs.db")
    check isHiddenOrJunkFile("Desktop.ini")
    check isHiddenOrJunkFile("desktop.ini")
    check isHiddenOrJunkFile("shortcut.lnk")

  test "temporary and partial downloads are junk":
    check isHiddenOrJunkFile("scratch.tmp")
    check isHiddenOrJunkFile("scratch.TEMP")
    check isHiddenOrJunkFile("movie.mp4.part")
    check isHiddenOrJunkFile("half.jpg.crdownload")
    check isHiddenOrJunkFile("half.jpg.download")
    check isHiddenOrJunkFile("notes.txt~")

  test "only the trailing extension counts":
    check not isHiddenOrJunkFile("photo.tmp.jpg")
    check not isHiddenOrJunkFile("desktop.ini.jpg")
    check not isHiddenOrJunkFile("thumbs.db.png")
    check not isHiddenOrJunkFile("IMG.jpg")
    check not isHiddenOrJunkFile("My Vacation (2024).JPEG")
    check not isHiddenOrJunkFile("temp.jpg")

  test "junk directories are pruned":
    check isJunkDirName("@eaDir")
    check isJunkDirName("@EADIR")
    check isJunkDirName("__MACOSX")
    check isJunkDirName("$RECYCLE.BIN")
    check isJunkDirName("RECYCLER")
    check isJunkDirName("System Volume Information")
    check isJunkDirName(".Trashes")
    check isJunkDirName(".Spotlight-V100")
    check isJunkDirName(".fseventsd")
    check isJunkDirName(".thumbs")
    check isJunkDirName(".frameos")
    check not isJunkDirName("vacation")
    check not isJunkDirName("2024-08 Norway")

  test "hasJunkPathComponent judges parents as dirs and the leaf as a file":
    check hasJunkPathComponent("@eaDir/IMG.jpg")
    check hasJunkPathComponent("vacation/@eaDir/beach.png")
    check hasJunkPathComponent("vacation/._beach.png")
    check hasJunkPathComponent(".thumbs/abc.320x320.jpg")
    check hasJunkPathComponent("__MACOSX\\IMG.jpg")
    check not hasJunkPathComponent("vacation/beach.png")
    check not hasJunkPathComponent("vacation/photo.tmp.jpg")

  test "walkDirRecNoJunk yields only real files and skips junk dirs":
    let root = getTempDir() / "frameos-junk-test"
    makeTree(root)
    defer: removeDir(root)

    var found: seq[string] = @[]
    for path in walkDirRecNoJunk(root, relative = true):
      found.add(path.replace('\\', '/'))
    found.sort()

    check found == @["IMG.jpg", "photo.tmp.jpg", "vacation/beach.png"]

    var absolute: seq[string] = @[]
    for path in walkDirRecNoJunk(root):
      absolute.add(path)
    check absolute.len == found.len
    for path in absolute:
      check path.startsWith(root)

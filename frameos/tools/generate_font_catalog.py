#!/usr/bin/env python3
"""The fonts a frame can get by itself: repo/fonts/catalog.txt.

The Fonts sample's "Get fonts" view reads this catalog straight from GitHub and
downloads the files it names straight from where they are, a range at a time,
into the frame's fonts folder (docs/esp32-fonts.md "Getting fonts onto the
card"). No control plane is in the way, and nothing here is converted on the
frame: every file is a TrueType font (glyf outlines, a format 4 or 12 Unicode
character map) that an ESP32 reads where it lies, as `font_for_card.py --check`
says of it.

- Google Fonts: the most popular families of each category that write Latin,
  each as its static Regular, Italic, Bold and Bold Italic where it has them
  (fonts.gstatic.com serves one TrueType file a style to a client that asks for
  no WOFF; versioned addresses, kept for years). The license is the folder the
  family is in on github.com/google/fonts (ofl, apache, ufl).
- FrameOS's own collection where Google Fonts does not have it (Liberation,
  FiraGO, Cascadia Mono, Noto Color Emoji): the files "Sync fonts" copies, from
  this repository at a fixed commit.

    python3 frameos/tools/generate_font_catalog.py            # writes repo/fonts/catalog.txt
    python3 frameos/tools/generate_font_catalog.py --check    # the file parses, names are unique

Every file is downloaded once and checked (about 100 MB); run it by hand when
the list should change, and commit the result.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "repo" / "fonts" / "catalog.txt"
SHIPPED = ROOT / "frameos" / "assets" / "copied" / "fonts"
GSTATIC = "https://fonts.gstatic.com/s/"
UA = "FrameOS font catalog"  # anything that is no browser gets TrueType files

# Families of each Google Fonts category, by popularity.
PER_CATEGORY = {"Sans Serif": 60, "Serif": 40, "Display": 50, "Handwriting": 35, "Monospace": 15}
STYLES = [("Regular", "400"), ("Italic", "400i"), ("Bold", "700"), ("BoldItalic", "700i")]
MAX_FILE_BYTES = 1200 * 1024  # a style bigger than this is a script font, not for a frame's card

# FrameOS's collection where Google Fonts has no such family: (name, category, license, [(style, file)]).
FRAMEOS_REF = "eae3bfe32aa2dcac2fc4805a4e4ba7c70784de93"  # a commit on main that holds these files
FRAMEOS_BASE = f"https://raw.githubusercontent.com/FrameOS/frameos/{FRAMEOS_REF}/frameos/assets/copied/fonts/"
FRAMEOS_FAMILIES = [
    ("Liberation Sans", "Sans Serif", "OFL",
     [("Regular", "LiberationSans-Regular.ttf"), ("Italic", "LiberationSans-Italic.ttf"),
      ("Bold", "LiberationSans-Bold.ttf"), ("BoldItalic", "LiberationSans-BoldItalic.ttf")]),
    ("Liberation Serif", "Serif", "OFL",
     [("Regular", "LiberationSerif-Regular.ttf"), ("Italic", "LiberationSerif-Italic.ttf"),
      ("Bold", "LiberationSerif-Bold.ttf"), ("BoldItalic", "LiberationSerif-BoldItalic.ttf")]),
    ("Liberation Mono", "Monospace", "OFL",
     [("Regular", "LiberationMono-Regular.ttf"), ("Italic", "LiberationMono-Italic.ttf"),
      ("Bold", "LiberationMono-Bold.ttf"), ("BoldItalic", "LiberationMono-BoldItalic.ttf")]),
    ("FiraGO", "Sans Serif", "OFL",
     [("Regular", "FiraGO-Regular.ttf"), ("Italic", "FiraGO-Italic.ttf"),
      ("Bold", "FiraGO-Bold.ttf"), ("BoldItalic", "FiraGO-BoldItalic.ttf")]),
    ("Cascadia Mono", "Monospace", "OFL",
     [("Regular", "CascadiaMono.ttf"), ("Italic", "CascadiaMonoItalic.ttf")]),
    ("Noto Color Emoji", "Emoji", "OFL", [("Regular", "NotoColorEmoji.ttf")]),
]

HEADER = """\
# FrameOS fonts catalog: what the Fonts scene offers to get, made by
# frameos/tools/generate_font_catalog.py (docs/esp32-fonts.md).
# A family a line, tab-separated: its name, category and license, then each
# style as "Style address bytes [file]": the address under the base line above
# it (or a whole https:// one), the file's size, and its name in the fonts
# folder when that is not the name without spaces, "-", the style and ".ttf".
"""


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def github_dirs(path: str) -> set[str]:
    """The folder names in google/fonts' `path` (ofl, apache, ufl)."""
    top = json.loads(get("https://api.github.com/repos/google/fonts/git/trees/main"))
    sha = next(t["sha"] for t in top["tree"] if t["path"] == path)
    tree = json.loads(get(f"https://api.github.com/repos/google/fonts/git/trees/{sha}"))
    return {t["path"] for t in tree["tree"] if t["type"] == "tree"}


def license_of(family: str, licenses: dict[str, set[str]]) -> str | None:
    folder = re.sub(r"[^a-z0-9]", "", family.lower())
    for name, folders in licenses.items():
        if folder in folders:
            return name
    return None


def styles_of(family: str, available: dict) -> dict[str, str]:
    """Style -> fonts.gstatic.com address, from the CSS API."""
    wanted = [(style, key) for style, key in STYLES if key in available]
    spec = ";".join(sorted(f"{1 if key.endswith('i') else 0},{key.rstrip('i')}" for _, key in wanted))
    css = get("https://fonts.googleapis.com/css2?family=" + urllib.parse.quote(family) + ":ital,wght@" + spec)
    found = {}
    for block in re.findall(r"@font-face\s*{([^}]*)}", css.decode()):
        italic = "italic" in re.search(r"font-style:\s*(\w+)", block).group(1)
        weight = re.search(r"font-weight:\s*(\d+)", block).group(1)
        url = re.search(r"url\((https://[^)]+\.ttf)\)", block)
        if not url:
            continue
        key = weight + ("i" if italic else "")
        for style, wanted_key in wanted:
            if wanted_key == key:
                found[style] = url.group(1)
    return found


def checked(url: str) -> tuple[int, str | None]:
    """The file's size, and why a frame cannot read it in place (None: it can)."""
    sys.path.insert(0, str(Path(__file__).parent))
    from font_for_card import problem
    from fontTools.ttLib import TTFont

    data = get(url)
    try:
        font = TTFont(io.BytesIO(data))
        if font.reader.sfntVersion == "OTTO":
            return len(data), "CFF outlines"
        if "fvar" in font:
            return len(data), "a variable font"
        return len(data), problem(font)
    except Exception as error:  # noqa: BLE001
        return len(data), f"not a font: {error}"


def file_name(family: str, style: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", family) + "-" + style + ".ttf"


def build() -> str:
    meta = json.loads(get("https://fonts.google.com/metadata/fonts"))["familyMetadataList"]
    licenses = {name: github_dirs(folder) for name, folder in (("OFL", "ofl"), ("Apache-2.0", "apache"), ("UFL", "ufl"))}
    key = lambda name: re.sub(r"[^a-z0-9]", "", name.lower())  # noqa: E731
    shipped_names = {key(f[0]) for f in FRAMEOS_FAMILIES}
    shipped = {key(path.stem): path.name for path in SHIPPED.glob("*.ttf")}
    picked = []
    taken = {category: 0 for category in PER_CATEGORY}
    for family in sorted(meta, key=lambda f: f["popularity"]):
        category = family["category"]
        if category not in PER_CATEGORY or taken[category] >= PER_CATEGORY[category]:
            continue
        if ("latin" not in family["subsets"] or not family["isOpenSource"] or family["isNoto"] or
                family["isBrandFont"] or family["colorCapabilities"] or family["primaryScript"] or
                "400" not in family["fonts"]):
            continue
        if key(family["family"]) in shipped_names:
            continue
        license = license_of(family["family"], licenses)
        if not license:
            print(f"skipped {family['family']}: no license folder on google/fonts", file=sys.stderr)
            continue
        picked.append((family, license))
        taken[category] += 1

    def entry(item):
        family, license = item
        styles = styles_of(family["family"], family["fonts"])
        parts = []
        for style, _ in STYLES:
            url = styles.get(style)
            if not url:
                continue
            size, why = checked(url)
            if why or size > MAX_FILE_BYTES:
                return None, f"{family['family']} {style}: {why or f'{size} bytes'}"
            # A family FrameOS ships keeps its file names: what a synced frame has is installed.
            file = shipped.get(key(family["family"] + style)) or (style == "Regular" and shipped.get(key(family["family"])))
            extra = f" {file}" if file and file != file_name(family["family"], style) else ""
            parts.append(f"{style} {url.removeprefix(GSTATIC)} {size}{extra}")
        if not parts or not parts[0].startswith("Regular "):
            return None, f"{family['family']}: no Regular"
        return "\t".join([family["family"], family["category"], license, *parts]), None

    lines = []
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for line, why in pool.map(entry, picked):
            if why:
                print("skipped " + why, file=sys.stderr)
            else:
                lines.append(line)
    lines.append(f"base {FRAMEOS_BASE}")
    for name, category, license, styles in FRAMEOS_FAMILIES:
        parts = []
        for style, file in styles:
            size = (SHIPPED / file).stat().st_size
            extra = "" if file == file_name(name, style) else f" {file}"
            parts.append(f"{style} {file} {size}{extra}")
        lines.append("\t".join([name, category, license, *parts]))
    return HEADER + f"base {GSTATIC}\n" + "\n".join(lines) + "\n"


def parse(text: str) -> list[dict]:
    """The catalog as the Fonts scene reads it (its app's parseCatalog)."""
    base = ""
    families = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("base "):
            base = line[5:].strip()
            continue
        name, category, license, *styles = line.split("\t")
        files = []
        for style in styles:
            words = style.split(" ")
            url = words[1] if words[1].startswith("https://") else base + words[1]
            files.append({"style": words[0], "url": url, "bytes": int(words[2]),
                          "file": words[3] if len(words) > 3 else file_name(name, words[0])})
        families.append({"name": name, "category": category, "license": license, "files": files})
    return families


def check(text: str) -> list[str]:
    problems = []
    seen_names, seen_files = set(), set()
    families = parse(text)
    if not families:
        problems.append("no families")
    for family in families:
        if family["name"] in seen_names:
            problems.append(f"{family['name']}: twice")
        seen_names.add(family["name"])
        if family["license"] not in ("OFL", "Apache-2.0", "UFL"):
            problems.append(f"{family['name']}: license {family['license']}")
        for f in family["files"]:
            if not f["url"].startswith("https://") or not f["url"].endswith(".ttf"):
                problems.append(f"{family['name']}: {f['url']}")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*\.ttf", f["file"]) or f["file"] in seen_files:
                problems.append(f"{family['name']}: file name {f['file']}")
            seen_files.add(f["file"])
            if f["bytes"] <= 0:
                problems.append(f"{family['name']}: {f['bytes']} bytes")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="only check the catalog that is there")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    text = args.out.read_text() if args.check else build()
    problems = check(text)
    for p in problems:
        print(p, file=sys.stderr)
    if problems:
        return 1
    if not args.check:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text)
        print(f"{args.out}: {len(parse(text))} families")
    return 0


if __name__ == "__main__":
    sys.exit(main())

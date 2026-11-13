#!/usr/bin/env python3
"""Gzip main/setup_page.html for the firmware (main/CMakeLists.txt).

Drops the comments and the line breaks first (the page is written so that
joining its lines changes nothing: every script statement ends in `;`, `{`,
`,` or an operator, and no string or template literal spans a line), then
gzips at level 9 with mtime 0 so the image stays reproducible.
"""
import gzip
import re
import sys


def minify(html: str) -> str:
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    html = re.sub(r"/\*.*?\*/", "", html, flags=re.S)
    return re.sub(r"\n+", "", html)


def main() -> None:
    source, target = sys.argv[1], sys.argv[2]
    with open(source, encoding="utf-8") as f:
        page = minify(f.read())
    with open(target, "wb") as f:
        f.write(gzip.compress(page.encode("utf-8"), 9, mtime=0))


if __name__ == "__main__":
    main()

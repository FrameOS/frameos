#!/usr/bin/env python3
"""Measure the ESP32 firmware image and render a size report.

Two subcommands:

  measure   Run after `idf.py build`. Reads the linker map through
            `esp_idf_size` (shipped with ESP-IDF's python env), demangles the
            nimcache object names, buckets every object into a subsystem (Nim
            apps, Nim core, QuickJS, pixie, Wi-Fi, TLS, ...), drills each
            subsystem down one level (core by directory, apps by app, packages
            by package, ESP-IDF by archive) and writes one JSON document next
            to the binaries. Runs from ci_build_image.sh so every CI and
            release build gets one.

  render    Turn one or more `measure` documents into the Markdown that CI
            posts as the sticky PR comment, diffed against a baseline — the
            latest GitHub release's size document when it has one, or just
            its asset byte counts when it does not.

The JSON is self-describing (`schema`), so a release built before this tool
existed yields a baseline with totals only and the report degrades to a
totals-only comparison instead of failing.
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

SCHEMA = 2
COMMENT_MARKER = "<!-- frameos-esp32-firmware-size -->"

NIM_OBJECT_SUFFIX = ".nim.c.obj"
NIM_ARCHIVE = "libframeos_nim.a"
# `esp_idf_size --files` keys look like `libframeos_nim.a:@m..@sframeos@sinterpreter.nim.c.obj`
# — or `...:@z..@fsenzrbf@fvagrecergre.nim.c.obj` when the Nim build ROT13s the
# mangled path (see _decode_name). The `.nim.c.obj` suffix is never mangled.
_NIM_PATH_RE = re.compile(r"^(?P<archive>[^:]+):(?P<path>.+)" + re.escape(NIM_OBJECT_SUFFIX) + r"$")

# Subsystem buckets, matched in order against (archive, decoded object path).
# The first matching rule wins. Keep the labels stable: the PR comment diffs
# them by name against the baseline document.
GROUP_RULES: list[tuple[str, Any]] = [
    ("Embedded font", lambda a, p: a == "libframeos_nim.a" and p.startswith("assets/fonts")),
    ("FrameOS apps (Nim)", lambda a, p: a == "libframeos_nim.a" and p.startswith("apps/")),
    ("pixie", lambda a, p: p.startswith("pkgs/pixie")),
    ("Nim stdlib", lambda a, p: p.startswith("nim/lib/")),
    ("Nim packages (chrono, zippy, chroma, qrgen, ...)", lambda a, p: p.startswith("pkgs/")),
    ("FrameOS core (Nim)", lambda a, p: a == "libframeos_nim.a"),
    ("QuickJS", lambda a, p: a == "libframeos_quickjs.a"),
    ("Display drivers (C)", lambda a, p: a == "libframeos_display.a"),
    ("fos_* firmware shell (C)", lambda a, p: a == "libmain.a"),
    ("String pool (attributed to efuse)", lambda a, p: a == "libefuse.a"),
    ("Crypto (monocypher)", lambda a, p: a == "libmonocypher.a"),
    (
        "Wi-Fi stack",
        lambda a, p: a
        in {
            "libnet80211.a",
            "libpp.a",
            "libphy.a",
            "libwpa_supplicant.a",
            "libcore.a",
            "libcoexist.a",
            "libesp_coex.a",
            "libesp_wifi.a",
            "libmesh.a",
            "libespnow.a",
            "libbtbb.a",
            "libesp_phy.a",
            "libsmartconfig.a",
        },
    ),
    (
        "mbedTLS + certificates",
        lambda a, p: a.startswith("libmbed") or a in {"libesp-tls.a", "libesp_https_ota.a", "libesp_https_server.a"},
    ),
    (
        "lwIP / HTTP / WebSocket",
        lambda a, p: a
        in {
            "liblwip.a",
            "libhttp_parser.a",
            "libesp_http_client.a",
            "libesp_http_server.a",
            "libtcp_transport.a",
            "libesp_netif.a",
            "libespressif__esp_websocket_client.a",
        },
    ),
    (
        "libc / libm / newlib",
        lambda a, p: a in {"libc.a", "libm.a", "libnewlib.a", "libstdc++.a", "libgcc.a", "libcxx.a"},
    ),
    (
        "Storage (SPIFFS / FatFS / SD / NVS)",
        lambda a, p: a
        in {
            "libspiffs.a",
            "libfatfs.a",
            "libsdmmc.a",
            "libnvs_flash.a",
            "libnvs_sec_provider.a",
            "libesp_driver_sdspi.a",
            "libesp_driver_sdmmc.a",
            "libspi_flash.a",
            "libesp_partition.a",
            "libvfs.a",
            "libesp_vfs_console.a",
        },
    ),
]
OTHER_GROUP = "ESP-IDF misc"

TOP_FILES = 150
# Rows kept per subsystem in the detail document. Well above what the comment
# renders, so `--detail-top` can be raised without re-measuring.
DETAIL_KEYS = 40
# ...and the remainder is folded into one "other" row so every table adds up.
DETAIL_OTHER = "(everything else)"


def _decode_name(key: str) -> tuple[str, str]:
    """Return (archive, human readable object name) for an esp_idf_size key."""
    match = _NIM_PATH_RE.match(key)
    if not match:
        archive, _, obj = key.partition(":")
        return archive, obj
    archive = match.group("archive")
    encoded = match.group("path")
    # esp_idf_size splits `libframeos_nim.a(<object>)` at the first `.a` it
    # sees — which for nimble packages is the `.a` of the ROT13'd `.nimble`
    # (`.avzoyr`), leaving `libframeos_nim.a(@z..@f.a` as the "archive" and
    # `vzoyr@fcxtf2@f...` as the path. Glue the two halves back together.
    if "(" in archive:
        archive, _, prefix = archive.partition("(")
        encoded = prefix + encoded
    # Nim mangles module paths as `@m<relative/path>` with `@s` for the
    # separator (compiler/modulepaths.nim). Whether that mangled name is then
    # ROT13-scrambled on disk depends on the Nim build: the official 2.2.4
    # tarball used by the Docker/CI image emits plain `@m..@sframeos@s...`,
    # while nixpkgs' Nim (the flox dev shell) applies mangleModuleName's rot13
    # and emits `@z..@fsenzrbf@f...`. ROT13 is its own inverse, so decoding
    # unconditionally would *scramble* the CI names and leave every marker
    # unmatched — which silently dumped pixie, the Nim stdlib, the apps and
    # the embedded font into the "FrameOS core (Nim)" bucket. Only decode
    # names that are actually scrambled; `@z` is ROT13 of the `@m` marker.
    path = codecs.decode(encoded, "rot13") if encoded.startswith("@z") else encoded
    return archive, f"{_normalize_nim_path(path)}.nim"


def _normalize_nim_path(path: str) -> str:
    """Turn a Nim-mangled module path into a stable, readable source path."""
    path = path.replace("@m", "").replace("@s", "/")
    # Collapse the `../../../..` climb out of the nimcache directory, and
    # rewrite toolchain locations so names do not change when the Nim
    # install path or a package hash does.
    path = re.sub(r"^(\.\./)+", "", path)
    path = re.sub(r"^.*?/nim/lib/", "nim/lib/", path)
    path = re.sub(r"^.*?\.nimble/pkgs2?/", "pkgs/", path)
    path = re.sub(r"^pkgs/([^/]+?)-[0-9a-f]{40}/", r"pkgs/\1/", path)
    return path


def _group_for(archive: str, name: str) -> str:
    for label, rule in GROUP_RULES:
        if rule(archive, name):
            return label
    return OTHER_GROUP


def _nim_detail_key(group: str, name: str) -> str:
    """One readable row label for a Nim object inside its subsystem.

    Each subsystem is split along the axis that is actually actionable for it:
    apps by app, packages by package, pixie and the stdlib by module, the core
    by directory (`frameos/js_runtime`, `frameos/utils`, ...) so the two big
    clusters do not drown in single files.
    """
    parts = name.split("/")
    if group == "FrameOS apps (Nim)":
        # apps/data/icalJson/ical.nim -> apps/data/icalJson
        return "/".join(parts[:3]) if len(parts) > 3 else name
    if group == "pixie":
        # pkgs/pixie-6.1.0/pixie/fileformats/svg.nim -> pixie/fileformats/svg.nim
        return "/".join(parts[2:]) if len(parts) > 2 else name
    if group == "Nim stdlib":
        return name[len("nim/lib/") :] if name.startswith("nim/lib/") else name
    if group.startswith("Nim packages"):
        # pkgs/chrono-0.3.1/chrono.nim -> chrono 0.3.1
        if len(parts) > 1:
            package, _, version = parts[1].rpartition("-")
            return f"{package} {version}" if package else parts[1]
        return name
    if group == "FrameOS core (Nim)":
        # frameos/js_runtime/transpiler.nim -> frameos/js_runtime; a module that
        # sits directly in frameos/ (or at the root) stays a row of its own.
        return "/".join(parts[:2]) if len(parts) > 2 else name
    return name


def _detail_key(group: str, archive: str, name: str, split_by_archive: bool) -> str:
    if archive == NIM_ARCHIVE and name.endswith(".nim"):
        return _nim_detail_key(group, name)
    # A subsystem built from several ESP-IDF archives (Wi-Fi, storage, lwIP,
    # "misc") is most legible per archive; one built from a single archive
    # (QuickJS, the fos_* shell, the display drivers) has to go per object.
    return archive if split_by_archive else name


def _details(entries: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Per-subsystem drill-down: {group: {row label: flash}}, biggest first."""
    archives: dict[str, set[str]] = {}
    for entry in entries:
        archives.setdefault(entry["group"], set()).add(entry["archive"])
    rows: dict[str, dict[str, int]] = {}
    for entry in entries:
        group = entry["group"]
        split = len(archives[group]) > 1 and entry["archive"] != NIM_ARCHIVE
        key = _detail_key(group, entry["archive"], entry["name"], split)
        bucket = rows.setdefault(group, {})
        bucket[key] = bucket.get(key, 0) + entry["flash"]
    trimmed: dict[str, dict[str, int]] = {}
    for group, bucket in rows.items():
        ordered = sorted(bucket.items(), key=lambda item: (-item[1], item[0]))
        kept = dict(ordered[:DETAIL_KEYS])
        rest = sum(flash for _, flash in ordered[DETAIL_KEYS:])
        if rest:
            kept[DETAIL_OTHER] = rest
        trimmed[group] = kept
    return trimmed


def _run_esp_idf_size(map_file: Path, *flags: str) -> dict[str, Any]:
    cmd = [sys.executable, "-m", "esp_idf_size", "--format", "json", *flags, str(map_file)]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def measure(args: argparse.Namespace) -> int:
    build_dir = Path(args.build_dir)
    map_file = Path(args.map) if args.map else build_dir / "frameos_esp32.map"
    doc: dict[str, Any] = {
        "schema": SCHEMA,
        "platform": args.platform,
        "version": args.version or None,
        "git_sha": args.git_sha or os.environ.get("GITHUB_SHA") or None,
        "app_bytes": _file_size(build_dir / "frameos_esp32.bin"),
        "merged_bytes": _file_size(build_dir / "merged-binary.bin"),
        "bootloader_bytes": _file_size(build_dir / "bootloader" / "bootloader.bin"),
        "partition_table_bytes": _file_size(build_dir / "partition_table" / "partition-table.bin"),
        "app_slot_bytes": args.app_slot_bytes,
        "flash_bytes": args.flash_bytes,
        "sections": None,
        "groups": None,
        "details": None,
        "archives": None,
        "files": None,
    }

    if not map_file.is_file():
        print(f"firmware_size: no linker map at {map_file}; writing totals only", file=sys.stderr)
    else:
        try:
            summary = _run_esp_idf_size(map_file)
            per_file = _run_esp_idf_size(map_file, "--files")
            per_archive = _run_esp_idf_size(map_file, "--archives")
        except (subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError) as error:
            print(f"firmware_size: esp_idf_size failed ({error}); writing totals only", file=sys.stderr)
        else:
            doc["sections"] = {
                key: summary.get(key)
                for key in (
                    "flash_code",
                    "flash_rodata",
                    "flash_other",
                    "used_flash_non_ram",
                    "total_size",
                    "used_iram",
                    "iram_total",
                    "used_diram",
                    "diram_total",
                    "used_dram",
                    "dram_total",
                )
            }
            groups: dict[str, dict[str, int]] = {}
            files: list[dict[str, Any]] = []
            for key, sections in per_file.items():
                flash = int(sections.get("flash_total", 0) or 0)
                if flash <= 0:
                    continue
                archive, name = _decode_name(key)
                group = _group_for(archive, name)
                bucket = groups.setdefault(group, {"flash": 0, "text": 0, "rodata": 0})
                bucket["flash"] += flash
                bucket["text"] += int(sections.get(".flash.text", 0) or 0)
                bucket["rodata"] += int(sections.get(".flash.rodata", 0) or 0)
                files.append({"name": name, "archive": archive, "group": group, "flash": flash})
            files.sort(key=lambda entry: (-entry["flash"], entry["name"]))
            doc["groups"] = dict(sorted(groups.items(), key=lambda item: -item[1]["flash"]))
            # Computed over every object, not just the `files` head: the
            # drill-down has to add up to its subsystem total.
            doc["details"] = _details(files)
            doc["files"] = files[:TOP_FILES]
            doc["archives"] = {
                archive: int(sections.get("flash_total", 0) or 0)
                for archive, sections in sorted(
                    per_archive.items(), key=lambda item: -int(item[1].get("flash_total", 0) or 0)
                )
                if int(sections.get("flash_total", 0) or 0) > 0
            }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    app = doc["app_bytes"]
    slot = doc["app_slot_bytes"]
    if app is not None and slot:
        print(f"firmware_size: app {app:,} bytes = {100 * app / slot:.1f}% of the {slot // 1024}K slot -> {out}")
    else:
        print(f"firmware_size: wrote {out}")
    return 0


# --- render -----------------------------------------------------------------


def _fmt_bytes(value: int | None) -> str:
    return "—" if value is None else f"{value:,}"


def _fmt_delta(current: int | None, baseline: int | None) -> str:
    if current is None or baseline is None:
        return "—"
    delta = current - baseline
    if delta == 0:
        return "±0"
    pct = f" ({100 * delta / baseline:+.1f}%)" if baseline else ""
    return f"{delta:+,}{pct}"


def _kib(value: int | None) -> str:
    return "—" if value is None else f"{value / 1024:,.0f} KB"


def _repair_legacy_names(doc: dict[str, Any]) -> dict[str, Any]:
    """Undo the double-ROT13 that older documents recorded for Nim objects.

    Documents written before the conditional-ROT13 fix scrambled the plain
    `@m..@sframeos@s...` names the CI toolchain emits, so every Nim object was
    stored under an unreadable name and bucketed into "FrameOS core (Nim)".
    Un-scramble the names so per-object diffs against such a baseline line up,
    and drop the group totals: they were computed over all objects, but only
    the top `TOP_FILES` are stored, so they cannot be recomputed here. An
    absent `groups` makes the report fall back to a no-baseline table instead
    of printing deltas against buckets that never existed.
    """
    files = doc.get("files") or []
    if not any(str(entry.get("name", "")).startswith("@z") for entry in files):
        return doc
    for entry in files:
        name = str(entry.get("name", ""))
        if not name.startswith("@z"):
            continue
        stem = name[: -len(".nim")] if name.endswith(".nim") else name
        entry["name"] = f"{_normalize_nim_path(codecs.decode(stem, 'rot13'))}.nim"
        entry["group"] = _group_for(str(entry.get("archive", "")), entry["name"])
    doc["groups"] = None
    return doc


def _load(path: str) -> dict[str, Any]:
    return _repair_legacy_names(json.loads(Path(path).read_text(encoding="utf-8")))


def _headroom(doc: dict[str, Any]) -> str:
    app, slot = doc.get("app_bytes"), doc.get("app_slot_bytes")
    if app is None or not slot:
        return ""
    return f"{100 * app / slot:.1f}% of {slot // 1024}K slot, {_kib(slot - app)} free"


def _totals_table(current_docs: list[dict[str, Any]], baselines: dict[str, dict[str, Any]], label: str) -> list[str]:
    lines = [
        f"| Image | This PR | {label} | Δ |",
        "|---|---:|---:|---:|",
    ]
    for doc in current_docs:
        platform = doc.get("platform", "?")
        base = baselines.get(platform, {})
        for key, title in (("app_bytes", "app (OTA image)"), ("merged_bytes", "merged flash image")):
            current, previous = doc.get(key), base.get(key)
            extra = ""
            if key == "app_bytes":
                headroom = _headroom(doc)
                if headroom:
                    extra = f"<br><sub>{headroom}</sub>"
            lines.append(
                f"| **{platform}** {title} | {_fmt_bytes(current)}{extra} | {_fmt_bytes(previous)} | {_fmt_delta(current, previous)} |"
            )
    return lines


def _groups_table(doc: dict[str, Any], base: dict[str, Any] | None, label: str) -> list[str]:
    groups = doc.get("groups") or {}
    base_groups = (base or {}).get("groups") or {}
    has_base = bool(base_groups)
    names = list(groups)
    for name in base_groups:
        if name not in groups:
            names.append(name)
    header = f"| Subsystem | This PR | {label} | Δ |" if has_base else "| Subsystem | Flash |"
    lines = [header, "|---|---:|---:|---:|" if has_base else "|---|---:|"]
    total = 0
    base_total = 0
    for name in names:
        current = groups.get(name, {}).get("flash")
        previous = base_groups.get(name, {}).get("flash")
        total += current or 0
        base_total += previous or 0
        if has_base:
            lines.append(f"| {name} | {_fmt_bytes(current)} | {_fmt_bytes(previous)} | {_fmt_delta(current, previous)} |")
        else:
            lines.append(f"| {name} | {_fmt_bytes(current)} |")
    if has_base:
        lines.append(f"| **Total mapped flash** | **{_fmt_bytes(total)}** | **{_fmt_bytes(base_total)}** | **{_fmt_delta(total, base_total)}** |")
    else:
        lines.append(f"| **Total mapped flash** | **{_fmt_bytes(total)}** |")
    return lines


def _files_table(doc: dict[str, Any], base: dict[str, Any] | None, label: str, limit: int) -> list[str]:
    files = (doc.get("files") or [])[:limit]
    base_index = {entry["name"]: entry["flash"] for entry in ((base or {}).get("files") or [])}
    has_base = bool(base_index)
    lines = [
        f"| Object | Subsystem | This PR | {label} | Δ |" if has_base else "| Object | Subsystem | Flash |",
        "|---|---|---:|---:|---:|" if has_base else "|---|---|---:|",
    ]
    for entry in files:
        name = entry["name"].replace("|", "\\|")
        if has_base:
            previous = base_index.get(entry["name"])
            lines.append(
                f"| `{name}` | {entry['group']} | {_fmt_bytes(entry['flash'])} | {_fmt_bytes(previous)} | {_fmt_delta(entry['flash'], previous)} |"
            )
        else:
            lines.append(f"| `{name}` | {entry['group']} | {_fmt_bytes(entry['flash'])} |")
    return lines


def _details_section(doc: dict[str, Any], base: dict[str, Any] | None, label: str, limit: int) -> list[str]:
    """One table per subsystem showing what is inside it, diffed when possible.

    This is the answer to "what is in FrameOS core (Nim)?" without downloading
    the map: the core by directory, the apps by app, the packages by package,
    pixie and the stdlib by module, and the ESP-IDF halves by archive.
    """
    details = doc.get("details") or {}
    if not details:
        return []
    base_details = (base or {}).get("details") or {}
    groups = doc.get("groups") or {}
    lines: list[str] = []
    for group, rows in sorted(details.items(), key=lambda item: -sum(item[1].values())):
        base_rows = base_details.get(group) or {}
        if len(rows) < 2 and not base_rows:
            continue
        total = groups.get(group, {}).get("flash") or sum(rows.values())
        has_base = bool(base_rows)
        lines.append(f"**{group}** — {_fmt_bytes(total)}")
        lines.append("")
        lines.append(f"| Part | This PR | {label} | Δ |" if has_base else "| Part | Flash |")
        lines.append("|---|---:|---:|---:|" if has_base else "|---|---:|")
        names = sorted(set(rows) | set(base_rows), key=lambda name: (-max(rows.get(name, 0), base_rows.get(name, 0)), name))
        for name in names[:limit]:
            safe = name.replace("|", "\\|")
            current = rows.get(name)
            previous = base_rows.get(name)
            if has_base:
                # A row missing on one side really is zero bytes there (the
                # tables cover every object), so show the full swing.
                lines.append(
                    f"| `{safe}` | {_fmt_bytes(current)} | {_fmt_bytes(previous)} | {_fmt_delta(current or 0, previous or 0)} |"
                )
            else:
                lines.append(f"| `{safe}` | {_fmt_bytes(current)} |")
        rest = names[limit:]
        if rest:
            current_rest = sum(rows.get(name, 0) for name in rest)
            base_rest = sum(base_rows.get(name, 0) for name in rest)
            row = f"| _{len(rest)} smaller rows_ | {_fmt_bytes(current_rest)} |"
            if has_base:
                row += f" {_fmt_bytes(base_rest)} | {_fmt_delta(current_rest, base_rest)} |"
            lines.append(row)
        lines.append("")
    if not lines:
        return []
    return ["<details>", "<summary>Inside each subsystem</summary>", "", *lines, "</details>", ""]


def _movers(doc: dict[str, Any], base: dict[str, Any] | None, limit: int = 15) -> list[str]:
    """Objects whose size changed the most against the baseline (both directions)."""
    base_files = (base or {}).get("files") or []
    if not base_files or not doc.get("files"):
        return []
    current = {entry["name"]: entry["flash"] for entry in doc["files"]}
    previous = {entry["name"]: entry["flash"] for entry in base_files}
    deltas = []
    for name in set(current) | set(previous):
        delta = current.get(name, 0) - previous.get(name, 0)
        if delta:
            deltas.append((abs(delta), delta, name))
    deltas.sort(reverse=True)
    if not deltas:
        return []
    lines = ["| Object | Δ | This PR | Baseline |", "|---|---:|---:|---:|"]
    for _, delta, name in deltas[:limit]:
        safe = name.replace("|", "\\|")
        lines.append(
            f"| `{safe}` | {delta:+,} | {_fmt_bytes(current.get(name))} | {_fmt_bytes(previous.get(name))} |"
        )
    return lines


def render(args: argparse.Namespace) -> int:
    current_docs = [_load(path) for path in args.current]
    baselines: dict[str, dict[str, Any]] = {}
    for path in args.baseline or []:
        doc = _load(path)
        baselines[doc.get("platform", "?")] = doc
    label = args.baseline_label or "Baseline"
    primary = current_docs[0]
    primary_base = baselines.get(primary.get("platform", "?"))

    out: list[str] = [COMMENT_MARKER, "## ESP32 firmware size", ""]
    if args.intro:
        out += [args.intro, ""]
    out += _totals_table(current_docs, baselines, label)
    out.append("")

    if primary.get("groups"):
        out.append(f"### Breakdown by subsystem — `{primary.get('platform')}`")
        out.append("")
        if not (primary_base and primary_base.get("groups")):
            out.append(
                f"_{label} has no comparable per-subsystem data — it predates this report, "
                "or its Nim buckets were mis-attributed; totals only above._"
            )
            out.append("")
        out += _groups_table(primary, primary_base, label)
        out.append("")
        out += _details_section(primary, primary_base, label, args.detail_top)
        movers = _movers(primary, primary_base)
        if movers:
            out += ["<details>", "<summary>Biggest movers (per object)</summary>", ""]
            out += movers
            out += ["", "</details>", ""]
        out += ["<details>", f"<summary>Largest {min(len(primary.get('files') or []), args.top)} objects</summary>", ""]
        out += _files_table(primary, primary_base, label, args.top)
        out += ["", "</details>", ""]
        out += [
            "<sub>Flash = `.text` + `.rodata` from the linker map via `esp_idf_size`; "
            "\"Inside each subsystem\" splits every bucket one level down (the Nim core by directory, "
            "apps by app, packages by package, ESP-IDF by archive) over all objects, not just the largest. "
            '"String pool (attributed to efuse)" is the linker\'s merged string-literal pool for the whole image, '
            "not efuse code — see `docs/esp32-image-size.md`.</sub>",
        ]
    else:
        out.append("_No linker-map breakdown was produced for this build._")

    if args.footer:
        out += ["", args.footer]
    text = "\n".join(out) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


def baseline_from_release(args: argparse.Namespace) -> int:
    """Synthesize totals-only baseline documents from a GitHub release's asset list.

    Used when the release predates `measure` and carries no size JSON: the
    asset byte counts of `*-esp32-<platform>-generic-app.bin` and
    `*-esp32-<platform>-generic.bin` are the app and merged image sizes.
    """
    release = _load(args.release_json)
    assets = {asset["name"]: asset for asset in release.get("assets", [])}
    tag = release.get("tagName") or release.get("tag_name") or ""
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for platform, slot in (("esp32-s3", 3520 * 1024), ("esp32-s3-32mb", 4032 * 1024), ("esp32-c3", 3520 * 1024)):
        suffix = "esp32-c3-generic" if platform == "esp32-c3" else "esp32-s3-generic"
        if platform == "esp32-s3-32mb":
            # Releases publish one S3 image (8 MB layout); the 32 MB build has
            # no released counterpart, so it gets no synthesized baseline.
            continue
        app = next((a for n, a in assets.items() if n.endswith(f"-{suffix}-app.bin")), None)
        merged = next((a for n, a in assets.items() if n.endswith(f"-{suffix}.bin")), None)
        if app is None and merged is None:
            continue
        doc = {
            "schema": SCHEMA,
            "platform": platform,
            "version": tag.lstrip("v") or None,
            "app_bytes": app.get("size") if app else None,
            "merged_bytes": merged.get("size") if merged else None,
            "app_slot_bytes": slot,
            "groups": None,
            "files": None,
        }
        (out_dir / f"{platform}.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        written += 1
    print(f"firmware_size: synthesized {written} baseline document(s) from release {tag or '?'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    m = sub.add_parser("measure", help="write a size JSON for one build directory")
    m.add_argument("--build-dir", required=True)
    m.add_argument("--platform", required=True)
    m.add_argument("--version", default="")
    m.add_argument("--git-sha", default="")
    m.add_argument("--map", default="")
    m.add_argument("--app-slot-bytes", type=int, default=None)
    m.add_argument("--flash-bytes", type=int, default=None)
    m.add_argument("--out", required=True)
    m.set_defaults(func=measure)

    r = sub.add_parser("render", help="render Markdown from size JSON documents")
    r.add_argument("--current", action="append", required=True, help="size JSON of this build (first = primary)")
    r.add_argument("--baseline", action="append", help="size JSON to compare against (matched by platform)")
    r.add_argument("--baseline-label", default="")
    r.add_argument("--intro", default="")
    r.add_argument("--footer", default="")
    r.add_argument("--top", type=int, default=30)
    r.add_argument("--detail-top", type=int, default=12, help="rows per subsystem in the drill-down")
    r.add_argument("--out", default="")
    r.set_defaults(func=render)

    b = sub.add_parser("baseline-from-release", help="synthesize totals-only baselines from a release asset list")
    b.add_argument("--release-json", required=True, help="`gh release view --json tagName,assets` output")
    b.add_argument("--out-dir", required=True)
    b.set_defaults(func=baseline_from_release)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

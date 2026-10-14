#!/usr/bin/env python3
"""Generate the scene guide's copies from docs/scene-guide.md.

docs/scene-guide.md is what everything that writes a scene reads: people, the
scene AI and the app AI on both control planes, and both MCP servers'
`scene_guide` tool. This script writes:

  docs/scene-guide.md                                its generated regions, in place
  backend/app/utils/scene_guide_gen.py               the backend's AI prompts and /api/scene_guide
  cloud/apps/auth-web/src/lib/ai/scene-guide.gen.ts  the cloud's AI prompts and /api/scenes/guide

The regions are
  events  what a scene may listen for or send, from docs/events-contract.json
  js-api  the declarations the editor type-checks JS apps against, from
          frontend/src/utils/appTypeDeclarations.ts and eventsContract.gen.ts

and it refuses when the runtime's `frameos` object or `app.frame` keys (the
prelude in frameos/src/frameos/js_runtime/app_runtime.nim) disagree with
those declarations, so a function added on one side reaches the guide.

  python3 frameos/tools/generate_scene_guide.py           write
  python3 frameos/tools/generate_scene_guide.py --check   exit 1 when anything is stale
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GUIDE = REPO / "docs" / "scene-guide.md"
CONTRACT = REPO / "docs" / "events-contract.json"
DECLARATIONS = REPO / "frontend" / "src" / "utils" / "appTypeDeclarations.ts"
EVENTS_GEN = REPO / "frontend" / "src" / "utils" / "eventsContract.gen.ts"
RUNTIME = REPO / "frameos" / "src" / "frameos" / "js_runtime" / "app_runtime.nim"
PY_OUT = REPO / "backend" / "app" / "utils" / "scene_guide_gen.py"
TS_OUT = REPO / "cloud" / "apps" / "auth-web" / "src" / "lib" / "ai" / "scene-guide.gen.ts"

HOST_NAMES = {"linux": "Pi", "esp32": "ESP32", "wasm": "preview"}


def fail(message: str) -> None:
    print(f"generate_scene_guide: {message}", file=sys.stderr)
    sys.exit(1)


def template_literal(source: str, start: str) -> str:
    """The text of the template literal that opens right after `start`."""
    at = source.find(start)
    if at < 0:
        fail(f"cannot find {start!r}")
    i = at + len(start)
    out = []
    while i < len(source):
        char = source[i]
        if char == "\\":
            out.append(source[i + 1])
            i += 2
            continue
        if char == "`":
            return "".join(out)
        out.append(char)
        i += 1
    fail(f"unterminated template literal after {start!r}")
    return ""


def js_api() -> str:
    declarations = template_literal(DECLARATIONS.read_text(), "return `")
    events_gen = EVENTS_GEN.read_text()
    declarations = declarations.replace("${configFields}", "  [key: string]: any;")
    declarations = declarations.replace("${eventTypeDeclarations}", template_literal(events_gen, "export const eventTypeDeclarations = `"))
    declarations = declarations.replace("${appContextMembers}", template_literal(events_gen, "export const appContextMembers = `"))
    if "${" in declarations:
        fail("appTypeDeclarations.ts interpolates something this script does not know: " + declarations[declarations.index("${"):][:40])
    return "```ts\n" + declarations.strip() + "\n```"


def block(source: str, opener: str, closer: str) -> str:
    at = source.find(opener)
    if at < 0:
        fail(f"cannot find {opener!r}")
    end = source.find(closer, at)
    if end < 0:
        fail(f"cannot find the end of {opener!r}")
    return source[at:end]


def check_runtime_matches(api: str) -> None:
    """The runtime's bridge and the editor's declarations name the same things."""
    runtime = RUNTIME.read_text()
    prelude = set(re.findall(r"^    (\w+): ", block(runtime, "  const frameos = {", "\n  };"), re.M))
    declared = set(re.findall(r"^  (\w+)\(", block(api, "declare const frameos: {", "\n};"), re.M))
    if prelude != declared:
        fail(
            "the runtime's frameos object and appTypeDeclarations.ts disagree: "
            f"only in the runtime {sorted(prelude - declared)}, only declared {sorted(declared - prelude)}"
        )
    frame_keys = re.search(r'of "frame":\s*\n\s*keys = @\[([^\]]*)\]', runtime)
    if not frame_keys:
        fail("cannot find the runtime's app.frame keys")
    runtime_frame = set(re.findall(r'"(\w+)"', frame_keys.group(1)))
    declared_frame = set(re.findall(r"(\w+)\??: ", block(api, "  frame: {", "\n  };").split("\n", 1)[1]))
    if runtime_frame != declared_frame:
        fail(
            "the runtime's app.frame keys and appTypeDeclarations.ts disagree: "
            f"only in the runtime {sorted(runtime_frame - declared_frame)}, only declared {sorted(declared_frame - runtime_frame)}"
        )


def first_sentence(text: str) -> str:
    text = " ".join(text.replace(" (not logged)", "").split())
    match = re.match(r"(.+?[.!?])(\s|$)", text)
    return (match.group(1) if match else text).replace("|", "\\|")


def events_table() -> str:
    contract = json.loads(CONTRACT.read_text())
    rows = [
        "| event | an `event` node hears it | a `dispatch` node sends it | `context.payload` | where | what |",
        "|---|---|---|---|---|---|",
    ]
    for event in contract["events"]:
        if not event.get("listen") and not event.get("dispatch"):
            continue
        payload = ", ".join(
            f"`{item['name']}`" + ("" if item.get("required") else "?") + f" {item['type']}" for item in event.get("payload", [])
        )
        hosts = [HOST_NAMES[name] for name, on in event.get("hosts", {}).items() if on and name in HOST_NAMES]
        where = "all" if len(hosts) == len(HOST_NAMES) else ", ".join(hosts)
        rows.append(
            f"| `{event['name']}` | {'yes' if event.get('listen') else ''} | {'yes' if event.get('dispatch') else ''} "
            f"| {payload} | {where} | {first_sentence(event.get('description', ''))} |"
        )
    return "\n".join(rows)


def fill(guide: str, name: str, content: str) -> str:
    begin = f"<!-- BEGIN GENERATED: {name} -->"
    end = f"<!-- END GENERATED: {name} -->"
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
    if not pattern.search(guide):
        fail(f"docs/scene-guide.md has no {name} region")
    return pattern.sub(lambda _: f"{begin}\n{content}\n{end}", guide)


def slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def served(guide: str) -> tuple[str, list[dict[str, str]]]:
    """The guide as readers get it: the part before the first `## ` heading,
    and each section. The whole guide is the two joined with blank lines."""
    text = re.sub(r"<!--.*?-->\n?", "", guide, flags=re.S).strip()
    parts = re.split(r"(?m)^(?=## )", text)
    intro, sections = parts[0].strip(), []
    for part in parts[1:]:
        title = part.splitlines()[0][3:].strip()
        sections.append({"id": slug(title), "title": title, "text": part.strip()})
    return intro, sections


def python_module(intro: str, sections: list[dict[str, str]]) -> str:
    return (
        "# Generated by frameos/tools/generate_scene_guide.py from docs/scene-guide.md — do not edit.\n"
        "# How to write a scene, for the scene and app AIs and the MCP scene_guide tool.\n\n"
        f"SCENE_GUIDE_INTRO: str = {json.dumps(intro, ensure_ascii=False)}\n\n"
        "# Each `## ` section of the guide: its id (the heading as a slug), its title and its text.\n"
        "SCENE_GUIDE_SECTIONS: tuple[dict[str, str], ...] = (\n"
        + "".join(f"    {json.dumps(section, ensure_ascii=False)},\n" for section in sections)
        + ")\n\n"
        "# The whole guide, as markdown.\n"
        'SCENE_GUIDE: str = "\\n\\n".join([SCENE_GUIDE_INTRO, *(section["text"] for section in SCENE_GUIDE_SECTIONS)]) + "\\n"\n'
    )


def ts_module(intro: str, sections: list[dict[str, str]]) -> str:
    return (
        "// Generated by frameos/tools/generate_scene_guide.py from docs/scene-guide.md — do not edit.\n"
        "// How to write a scene, for the scene and app AIs and the MCP scene_guide tool.\n\n"
        f"export const SCENE_GUIDE_INTRO = {json.dumps(intro, ensure_ascii=False)};\n\n"
        "export type SceneGuideSection = { id: string; title: string; text: string };\n\n"
        "/** Each `## ` section of the guide: its id (the heading as a slug), its title and its text. */\n"
        "export const SCENE_GUIDE_SECTIONS: readonly SceneGuideSection[] = [\n"
        + "".join(f"  {json.dumps(section, ensure_ascii=False)},\n" for section in sections)
        + "];\n\n"
        "/** The whole guide, as markdown. */\n"
        'export const SCENE_GUIDE = [SCENE_GUIDE_INTRO, ...SCENE_GUIDE_SECTIONS.map((section) => section.text)].join("\\n\\n") + "\\n";\n'
    )


def main() -> None:
    check = "--check" in sys.argv[1:]
    api = js_api()
    check_runtime_matches(api)
    guide = fill(GUIDE.read_text(), "events", events_table())
    guide = fill(guide, "js-api", api)
    intro, sections = served(guide)
    outputs = {GUIDE: guide, PY_OUT: python_module(intro, sections), TS_OUT: ts_module(intro, sections)}
    stale = [path for path, content in outputs.items() if not path.exists() or path.read_text() != content]
    if check:
        if stale:
            fail("stale: " + ", ".join(str(path.relative_to(REPO)) for path in stale) + " (run frameos/tools/generate_scene_guide.py)")
        return
    for path in stale:
        path.write_text(outputs[path])
        print(f"wrote {path.relative_to(REPO)}")


if __name__ == "__main__":
    main()

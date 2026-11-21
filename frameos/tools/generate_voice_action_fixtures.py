#!/usr/bin/env python3
"""Writes docs/voice-action-fixtures.json: the corpus both control planes
replay for voice actions (docs/voice-chat.md "Voice actions") — the backend's
app/utils/voice_actions.py and the cloud's src/lib/ai/voice-actions.ts.

Each case is an utterance on a screen: the Jev request a plane must build,
Jev's answers (recorded from the real API with --record, kept otherwise) and
the plan a plane must make of them. Plus the words each utterance offers to
type, the chat's screen context block and the chat's screen tools.

The screens are real digests (frameos/voice_screen.nim) dumped by the Nim
test: FRAMEOS_VOICE_SCREEN_DUMP=<dir> on test_voice_actions.nim, then
--screens <dir>. Without --screens the corpus keeps the screens it has.

  python3 frameos/tools/generate_voice_action_fixtures.py [--screens DIR] [--record] [--check]

--record needs TYPESAFE_API_KEY (or the repo's .env.local)."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
from app.utils import voice_actions as va  # noqa: E402

OUT = REPO / "docs" / "voice-action-fixtures.json"
NOW = "2026-11-20T18:45:00Z"

TODO = json.loads((REPO / "repo/scenes/samples/To-do/scenes.json").read_text())[0]
MEMOS = json.loads((REPO / "repo/scenes/samples/Voice memos/scenes.json").read_text())[0]


def lean(scene: dict) -> dict:
    """What a plane reads of a scene for a voice action: its id, name,
    custom events, event nodes and apps' config.json (not their sources)."""
    out = {"id": scene["id"], "name": scene["name"], "customEvents": scene.get("customEvents") or []}
    out["nodes"] = [{"type": n["type"], "data": {"keyword": n["data"].get("keyword")}} for n in scene["nodes"] if n["type"] == "event"]
    out["apps"] = {k: {"sources": {"config.json": a["sources"]["config.json"]}} for k, a in (scene.get("apps") or {}).items()}
    return out


SCENES = [
    {"id": "to-do", "name": "To-do"},
    {"id": "voice-memos", "name": "Voice memos"},
    {"id": "calendar", "name": "Calendar"},
    {"id": "clock", "name": "Clock"},
    {"id": "weather", "name": "Weather"},
]

# A desktop with windows (docs/scene-layouts.md "Windows"): the layout's own
# taskbar and the focused window's UI. Written by hand from the Windows 98
# sample's look; the digest's shape is the Nim test's.
DESKTOP = {
    "v": 1, "scene": "calendar", "open": ["calendar", "to-do", "clock"],
    "t": [
        {"id": "3:12:windows-98", "do": "tap", "text": "Start"},
        {"id": "3:40:windows-98", "do": "tap", "text": "Calendar", "near": "Calendar To-do Clock 18:45"},
        {"id": "3:41:windows-98", "do": "tap", "text": "To-do", "near": "Calendar To-do Clock 18:45"},
        {"id": "3:42:windows-98", "do": "tap", "text": "Clock", "near": "Calendar To-do Clock 18:45"},
        {"id": "3:77:windows-98", "do": "tap", "label": "Close", "near": "Calendar"},
        {"id": "2:31", "do": "tap", "label": "Previous month", "near": "November 2026"},
        {"id": "2:32", "do": "tap", "label": "Next month", "near": "November 2026"},
        {"id": "2:35", "do": "tap", "text": "Today"},
    ],
}

CASES = [
    # (name, screen, scene, said)
    ("todo add", "to-do", TODO, "Add milk."),
    ("todo add, put on the list", "to-do", TODO, "Put call the plumber on the list."),
    ("todo add, new to-do", "to-do", TODO, "New to-do: water the garden."),
    ("todo tick off", "to-do", TODO, "Mark the dentist as done."),
    ("todo delete", "to-do", TODO, "Delete the bike light one."),
    ("todo rename", "to-do", TODO, "Rename book the dentist to call the dentist."),
    ("todo switch", "to-do", TODO, "Show me the calendar."),
    ("todo several", "to-do", TODO, "Add eggs and bread."),
    ("todo question", "to-do", TODO, "What's the weather like?"),
    ("todo tick off what is not there", "to-do", TODO, "Tick off the plumber."),
    ("todo delete what is not there", "to-do", TODO, "Delete the swimming lesson."),
    ("todo tick off two", "to-do", TODO, "Tick off the dentist and the recycling."),
    ("todo add, not on screen yet", "to-do", TODO, "Add call the plumber."),
    ("todo dictation", "to-do-keyboard", TODO, "and new brakes too"),
    ("todo enter", "to-do-keyboard", TODO, "Send it."),
    ("todo hidden row", "to-do-keyboard", TODO, "Delete the dentist."),
    ("memos open", "voice-memos", MEMOS, "Open the plumber memo."),
    ("memos delete", "voice-memos", MEMOS, "Delete the oat milk one."),
    ("memos fallback", "voice-memos", MEMOS, "Remind me to call mom on Sunday."),
    ("memos next page", "voice-memos", MEMOS, "Next page."),
    ("desktop focus window", "desktop", None, "Bring the to-do list to the front."),
    ("desktop press", "desktop", None, "Go to next month."),
]

# Answers that test the plan's rules rather than Jev: an unsure kind, an
# unsure target, "none".
SYNTHETIC = [
    ("unsure kind goes to the chat", "to-do", TODO, "Milk.",
     {"kind": {"type": "choice", "choice": "fill", "confidence": 0.2, "probabilities": {"fill": 0.4, "press": 0.35, "other": 0.25}}}),
    ("none of these goes to the chat", "to-do", TODO, "Tick off the swimming lesson.",
     {"kind": {"type": "choice", "choice": "press", "confidence": 0.9, "probabilities": {"press": 0.95}},
      "press": {"type": "choice", "choice": "none", "confidence": 0.9, "probabilities": {"none": 0.97}}}),
]

TEXTS = [
    "Add milk.", "add milk to the list", "Type hello world.", "New to-do: water the garden.",
    "Please add a new item called oat milk to my list", "Rename book the dentist to call the dentist.",
    "Write “buy flowers”", "and new brakes too", "Put call the plumber on the list.",
    "Note down: the code is 1234.", "Remind me to call mom on Sunday.",
]

TOOLS = [
    ("to-do", TODO, "Add eggs and bread.", [
        ["type_text", {"target": "2:125", "text": "Eggs", "submit": True}],
        ["type_text", {"target": "2:125", "text": "Bread", "submit": True}],
        ["press", {"target": "2:nope"}],
        ["scene_action", {"name": "voiceMemo"}],
    ]),
    ("voice-memos", MEMOS, "Save this and go to the next page.", [
        ["scene_action", {"name": "voiceMemo", "text": "this"}],
        ["scene_action", {"name": "forward"}],
        ["type_text", {"target": "2:94", "text": "  "}],
    ]),
]


def jev_key() -> str | None:
    key = os.environ.get("TYPESAFE_API_KEY")
    # The checkout's .env.local, or the main checkout's from a git worktree.
    import subprocess

    common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    for env in (REPO / ".env.local", (REPO / common).resolve().parent / ".env.local" if common else None):
        if key or env is None or not env.exists():
            continue
        for line in env.read_text().splitlines():
            if line.startswith("TYPESAFE_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    return key


def plan_json(plan: va.VoiceActionPlan | None):
    if plan is None:
        return None
    keep = {k: v for k, v in plan.log.items() if k not in ("p", "targetP")}
    return {"kind": plan.kind, "events": plan.events, "reply": plan.reply, "log": keep}


async def build(screens: dict, previous: dict, record: bool) -> dict:
    now = datetime.fromisoformat(NOW.replace("Z", "+00:00"))
    recorded = {c["name"]: c["answers"] for c in previous.get("decisions", [])}
    key = jev_key() if record else None
    if record and not key:
        raise SystemExit("--record needs TYPESAFE_API_KEY")
    decisions = []
    for name, screen_name, scene, said in CASES:
        screen = va.read_screen(json.dumps(screens[screen_name]))
        lean_scene = lean(scene) if scene else None
        decision = va.build_decision(transcript=said, screen=screen, scene=lean_scene, scenes=SCENES)
        if key:
            answers = await va.ask_jev(decision.request, api_key=key)
        elif name in recorded:
            answers = recorded[name]
        else:
            raise SystemExit(f"no recorded answers for {name!r}: run with --record")
        plan = va.plan_from_answers(decision, answers, transcript=said, now=now)
        decisions.append({"name": name, "screen": screen_name, "scene": lean_scene, "said": said,
                          "request": decision.request, "answers": answers, "plan": plan_json(plan)})
    for name, screen_name, scene, said, answers in SYNTHETIC:
        screen = va.read_screen(json.dumps(screens[screen_name]))
        lean_scene = lean(scene) if scene else None
        decision = va.build_decision(transcript=said, screen=screen, scene=lean_scene, scenes=SCENES)
        plan = va.plan_from_answers(decision, answers, transcript=said, now=now)
        decisions.append({"name": name, "screen": screen_name, "scene": lean_scene, "said": said,
                          "request": decision.request, "answers": answers, "plan": plan_json(plan)})
    contexts = []
    for screen_name, scene in (("to-do", TODO), ("voice-memos", MEMOS), ("desktop", None)):
        screen = va.read_screen(json.dumps(screens[screen_name]))
        contexts.append({"screen": screen_name, "scene": lean(scene) if scene else None,
                         "block": va.screen_context_block(screen, lean(scene) if scene else None)})
    tools = []
    for screen_name, scene, said, calls in TOOLS:
        screen = va.read_screen(json.dumps(screens[screen_name]))
        box = va.VoiceScreenTools(screen=screen, scene=lean(scene), transcript=said, now=now)
        results = [box.call(tool, args) for tool, args in calls]
        tools.append({"screen": screen_name, "scene": lean(scene), "said": said,
                      "calls": [[tool, args, result] for (tool, args), result in zip(calls, results)],
                      "events": box.events})
    reads = []
    for screen_name in ("to-do", "voice-memos"):
        reads.append({"screen": screen_name, "read": va.read_screen(json.dumps(screens[screen_name]))})
    reads.append({"raw": {"v": 2, "t": []}, "read": None})
    reads.append({"raw": {"v": 1, "scene": "x", "t": [{"id": 3, "do": "tap"}, {"id": "1:2", "do": "fly"},
                                                      {"id": "1:3", "do": "tap", "text": "  Hi  ", "focus": "yes"}]},
                  "read": va.read_screen(json.dumps({"v": 1, "scene": "x", "t": [{"id": 3, "do": "tap"}, {"id": "1:2", "do": "fly"},
                                                                                {"id": "1:3", "do": "tap", "text": "  Hi  ", "focus": "yes"}]}))})
    return {
        "$comment": (
            "Voice actions (docs/voice-chat.md \"Voice actions\"): what both control planes must build and decide. "
            "Written by frameos/tools/generate_voice_action_fixtures.py; replayed by "
            "backend/app/utils/tests/test_voice_actions.py and cloud/apps/auth-web/src/lib/ai/voice-actions.test.ts. "
            "`answers` are Jev's, recorded from the real API (--record) except the synthetic cases."
        ),
        "now": NOW,
        "scenes": SCENES,
        "screens": screens,
        "reads": reads,
        "texts": [{"said": said, "candidates": va.text_candidates(said)} for said in TEXTS],
        "decisions": decisions,
        "contexts": contexts,
        "tools": tools,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screens", type=Path)
    parser.add_argument("--record", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    previous = json.loads(OUT.read_text()) if OUT.exists() else {}
    screens = dict(previous.get("screens", {}))
    if args.screens:
        for name, scene_id in (("to-do", "to-do"), ("to-do-keyboard", "to-do"), ("voice-memos", "voice-memos")):
            screens[name] = json.loads((args.screens / f"{name}.json").read_text())
            screens[name]["scene"] = scene_id  # the test's own id, as the frame's would be
    screens["desktop"] = DESKTOP
    corpus = asyncio.run(build(screens, previous, args.record))
    text = json.dumps(corpus, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if OUT.read_text() != text:
            raise SystemExit(f"{OUT.relative_to(REPO)} is stale: run frameos/tools/generate_voice_action_fixtures.py")
        return
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(REPO)}: {len(corpus['decisions'])} decisions")


if __name__ == "__main__":
    main()

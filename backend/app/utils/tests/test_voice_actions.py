"""Voice actions (docs/voice-chat.md "Voice actions"): the backend replays
docs/voice-action-fixtures.json, the corpus the cloud's voice-actions.ts
replays too — the request built for an utterance on a screen, the plan made
of Jev's answers, the words to type, the chat's screen context and tools.
And the corpus is what its generator writes (--check)."""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

from app.utils import voice_actions as va

REPO = Path(__file__).resolve().parents[4]
CORPUS = json.loads((REPO / "docs" / "voice-action-fixtures.json").read_text())
NOW = datetime.fromisoformat(CORPUS["now"].replace("Z", "+00:00"))


def screen(name: str) -> dict | None:
    return va.read_screen(json.dumps(CORPUS["screens"][name]))


def plan_json(plan):
    if plan is None:
        return None
    return {"kind": plan.kind, "events": plan.events, "reply": plan.reply,
            "log": {k: v for k, v in plan.log.items() if k not in ("p", "targetP")}}


def test_the_corpus_is_what_its_generator_writes():
    result = subprocess.run(
        [sys.executable, str(REPO / "frameos" / "tools" / "generate_voice_action_fixtures.py"), "--check"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("case", CORPUS["reads"], ids=lambda c: c.get("screen") or "raw")
def test_read_screen(case):
    raw = CORPUS["screens"][case["screen"]] if "screen" in case else case["raw"]
    assert va.read_screen(json.dumps(raw)) == case["read"]


def test_read_screen_refuses_what_is_no_digest():
    assert va.read_screen(b"") is None
    assert va.read_screen(b"not json") is None
    assert va.read_screen(b"[1]") is None
    assert va.read_screen(b"x" * (va.MAX_SCREEN_BYTES + 1)) is None


@pytest.mark.parametrize("case", CORPUS["texts"], ids=lambda c: c["said"])
def test_text_candidates(case):
    assert va.text_candidates(case["said"]) == case["candidates"]


@pytest.mark.parametrize("case", CORPUS["decisions"], ids=lambda c: c["name"])
def test_decision(case):
    decision = va.build_decision(transcript=case["said"], screen=screen(case["screen"]), scene=case["scene"],
                                 scenes=CORPUS["scenes"])
    assert decision.request == case["request"]
    plan = va.plan_from_answers(decision, case["answers"], transcript=case["said"], now=NOW)
    assert plan_json(plan) == case["plan"]


@pytest.mark.parametrize("case", CORPUS["contexts"], ids=lambda c: c["screen"])
def test_screen_context_block(case):
    assert va.screen_context_block(screen(case["screen"]), case["scene"]) == case["block"]


@pytest.mark.parametrize("case", CORPUS["tools"], ids=lambda c: c["said"])
def test_screen_tools(case):
    box = va.VoiceScreenTools(screen=screen(case["screen"]), scene=case["scene"], transcript=case["said"], now=NOW)
    for tool, args, result in case["calls"]:
        assert box.call(tool, args) == result
    assert box.events == case["events"]


@pytest.mark.asyncio
async def test_a_jev_that_fails_is_the_chats():
    async def refused(request):
        raise va.JevError("Jev refused (503)")

    case = CORPUS["decisions"][0]
    outcome = await va.decide_voice_action(transcript=case["said"], screen=screen(case["screen"]), scene=case["scene"],
                                           scenes=CORPUS["scenes"], ask=refused, now=NOW)
    assert outcome.plan is None and "503" in outcome.error


def test_custom_event_declarations_for_voice():
    events, fallback = va.scene_voice_events({"customEvents": [
        {"name": "nextPage"},  # no description, no aliases: not offered
        {"name": "refresh", "description": "Fetch the news again", "aliases": ["update", 3, " "]},
        {"name": "secret", "description": "Not for voice", "voice": "never"},
        {"name": "memo", "description": "Save a memo", "voice": "fallback"},
        {"name": "memo2", "description": "Another", "voice": "fallback"},
    ]})
    assert events == [{"name": "refresh", "description": "Fetch the news again", "aliases": ["update"]}]
    assert fallback == {"name": "memo", "description": "Save a memo", "aliases": []}

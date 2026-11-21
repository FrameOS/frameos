"""Voice actions (docs/voice-chat.md "Voice actions"): what was said at the
frame's voice key, matched to what the frame can do right now, and done by
the frame itself without a chat turn.

The frame sends a screen digest before its audio (frameos/voice_screen.nim:
the elements of the scene's UIs a tap, a field or a scroll reaches, whether
the keyboard is up, the windows beside it, the scene's state). The plane adds
what it holds of the scene (its custom events with their `description`,
`aliases` and `voice` role, docs/events.md) and of the frame (its other
scenes), and asks TypeSafe's Jev, a decision model, ONE request of typed
questions: which kind of thing was asked, which element, which custom event,
which scene, which exact words to type, whether to send them. Jev answers
every question in one pass, with probabilities, in a few hundred
milliseconds. A sure answer becomes the events the frame dispatches from the
origin `voice` (`uiAction`, a custom event, `setCurrentScene`), carried back
in the reply; "several things", "something else" or an unsure answer goes to
the voice chat (app/utils/voice_chat.py), which gets the same screen as
tools (`press`, `type_text`, `scene_action`) and steers.

The cloud's copy is cloud/apps/auth-web/src/lib/ai/voice-actions.ts; both
replay docs/voice-action-fixtures.json, which pins the request each builds
and the plan each makes of Jev's answers."""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

JsonObject = dict[str, Any]

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
JEV_TIMEOUT_SECONDS = 8.0

# What a frame may send: the digest of one screen, its targets and texts cut
# by the frame already (ui/layout.nim SpotText, 64 targets).
MAX_SCREEN_BYTES = 32 * 1024
MAX_SCREEN_TARGETS = 64
MAX_TARGET_TEXT = 160
# A choice question takes 2 to 255 options; past this many a list is cut.
MAX_OPTIONS = 64
MAX_TEXT_CANDIDATES = 6
MAX_EVENT_TEXT = 1000

# Jev's answer is acted on only when it is this sure: the kind of action, then
# the element, event or scene it names. Below either, the chat decides.
MIN_KIND_PROBABILITY = 0.45
MIN_TARGET_PROBABILITY = 0.35
SUBMIT_PROBABILITY = 0.5
# Dictating with the keyboard up is words to go on editing: Enter only when
# it is clearly asked for (or the kind is `enter`).
DICTATION_SUBMIT_PROBABILITY = 0.8
REPLACE_PROBABILITY = 0.5
# Two yes / no checks ride with every request: "several things" (two items to
# tick off is the chat's, never the first of them alone) and "an item that is
# not on the screen" (ticking off what is not there is never typing it in as
# a new one). Either at this or above and the chat decides.
SEVERAL_PROBABILITY = 0.5
ABSENT_PROBABILITY = 0.5

# The kinds of thing a person asks for, as Jev's first question offers them.
KIND_TYPE = "type"        # dictating into the field that has the keyboard
KIND_ENTER = "enter"      # Enter in that field: send it, add it, done
KIND_FILL = "fill"        # words into a field on the screen (an item added, a field changed)
KIND_PRESS = "press"      # a button, an icon, an item
KIND_ACTION = "action"    # one of the scene's own actions (custom events, back / forward)
KIND_SWITCH = "switch"    # another scene, or a window brought to the front
KIND_SEVERAL = "several"  # more than one thing: the chat steers
KIND_OTHER = "other"      # a question, a new scene, a setting: the chat
KIND_FALLBACK = "fallback"  # the scene's catch-all event (a memo)

KIND_DESCRIPTIONS = {
    KIND_TYPE: "Dictating: the words are to be typed into the text field that has the keyboard",
    KIND_ENTER: "Press Enter in the text field that has the keyboard: send it, add it, done, that's it",
    KIND_FILL: "Put words into a text field on the screen: add an item by typing it in, or change what a field says",
    KIND_PRESS: "Press something on the screen: a button, an icon, a checkbox, an item in a list",
    KIND_ACTION: "One of the scene's own actions",
    KIND_SWITCH: "Show another scene or app, or bring an open window to the front",
    KIND_SEVERAL: "Several different things to do in one request (two items to add, or a change and then a switch)",
    KIND_OTHER: (
        "Something else: a question, making a new scene or picture, a setting of the frame or of the scene, "
        "or nothing on this screen fits"
    ),
}

QUESTION_KIND = "What does the person want the frame to do with what they said?"
QUESTION_PRESS = "Which element on the screen should be pressed to do what they asked?"
QUESTION_FIELD = "Which text field should the words go into?"
QUESTION_ACTION = "Which of the scene's actions did they ask for?"
QUESTION_SWITCH = "Which scene or window should the frame show?"
QUESTION_WORDS = (
    "Exactly which words should be typed into the field? Leave out command words (add, type, write, put) "
    "and where to put them (to the list, into the field)."
)
QUESTION_SUBMIT = (
    "Should the words be entered right away, as pressing Enter does: an item added to a list, a message sent, a "
    "search run? Yes when they asked to add, send, save, search or enter something; no when they are only "
    "dictating words into a field to go on editing."
)
NONE_OPTION = "none"
NONE_WORDS = "None of these"

QUESTION_SEVERAL = (
    "Does the request ask for more than one separate thing to be done: two or more items to add, tick off"
    " or delete, or two different actions?"
)
QUESTION_ABSENT = (
    "Does the request ask to act on a particular existing item (tick it off, mark it done, open, delete, "
    "rename or change it) that none of the things on the screen is about?"
)
QUESTION_REPLACE = (
    "Should what the field says now be replaced by the new words (renaming or correcting it), rather than added to?"
)

BACK_ACTION = {"name": "back", "description": "Go back: the previous page, photo or step", "aliases": ["previous page"]}
FORWARD_ACTION = {"name": "forward", "description": "Go forward: the next page, photo or step", "aliases": ["next page"]}

# The replies the frame shows under what it heard, and the name the log row
# and the frame's `tools` give a voice action (a non-empty `tools` is the
# frame's "did something" sound).
VOICE_ACTION_TOOL = "voice_action"
REPLY_TYPED = "Typed “{text}”."
REPLY_ADDED = "Added “{text}”."
REPLY_PRESSED = "Pressed {what}."
REPLY_ACTION = "{what}."
REPLY_SWITCHED = "Showing {what}."


@dataclass
class VoiceActionPlan:
    """What the frame should do: `events` to dispatch from the origin `voice`
    in order, the `reply` it shows, and the log row's account of it."""
    kind: str
    events: list[JsonObject]
    reply: str
    log: JsonObject
    tools: list[str] = field(default_factory=lambda: [VOICE_ACTION_TOOL])


@dataclass
class VoiceDecision:
    """The Jev request for one utterance on one screen, and what its option
    names stand for."""
    request: JsonObject
    targets: dict[str, JsonObject] = field(default_factory=dict)   # p0.., f0.. -> screen target
    actions: dict[str, JsonObject] = field(default_factory=dict)   # a0.. -> custom event / back / forward
    scenes: dict[str, JsonObject] = field(default_factory=dict)    # s0.. -> {id, name}
    words: dict[str, str] = field(default_factory=dict)            # w0.. -> text
    fallback: JsonObject | None = None


# ----------------------------------------------------------------- reading


def _clip(value: Any, limit: int = MAX_TARGET_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def read_screen(raw: bytes | str | None) -> JsonObject | None:
    """The frame's screen digest, its shape checked and its texts cut: what
    a frame says is data, never instructions. None for anything that is not
    one (an empty body, other JSON, a newer version)."""
    if not raw or len(raw) > MAX_SCREEN_BYTES:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict) or data.get("v") != 1:
        return None
    screen: JsonObject = {"v": 1, "scene": _clip(data.get("scene"), 200), "kb": data.get("kb") is True, "targets": []}
    open_windows = data.get("open")
    if isinstance(open_windows, list):
        screen["open"] = [_clip(item, 200) for item in open_windows if isinstance(item, str)][:16]
    state = data.get("state")
    if isinstance(state, dict):
        screen["state"] = state
    for item in data.get("t") or []:
        if len(screen["targets"]) >= MAX_SCREEN_TARGETS:
            break
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        action = item.get("do")
        if action not in ("tap", "type", "pick", "scroll"):
            continue
        target: JsonObject = {"id": _clip(item["id"], 300), "do": action}
        for key in ("text", "label", "near"):
            text = _clip(item.get(key))
            if text:
                target[key] = text
        for key in ("focus", "lines", "number", "scroll"):
            if item.get(key) is True:
                target[key] = True
        screen["targets"].append(target)
    return screen


def scene_voice_events(scene: JsonObject | None) -> tuple[list[JsonObject], JsonObject | None]:
    """The scene's custom events a spoken request can name (`voice` absent or
    `match`, with a description or aliases), and its catch-all (`voice:
    fallback`, the first one), each as {name, description, aliases}."""
    events: list[JsonObject] = []
    fallback: JsonObject | None = None
    declared = (scene or {}).get("customEvents")
    if not isinstance(declared, list):
        return events, None
    for entry in declared:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not entry["name"]:
            continue
        role = entry.get("voice") or "match"
        description = _clip(entry.get("description"), 300)
        aliases = [_clip(a, 80) for a in (entry.get("aliases") or []) if isinstance(a, str) and a.strip()][:12]
        item = {"name": entry["name"], "description": description, "aliases": aliases}
        if role == "fallback":
            if fallback is None:
                fallback = item
        elif role == "match" and (description or aliases):
            events.append(item)
    return events, fallback


def scene_listens_for(scene: JsonObject | None, event: str) -> bool:
    """Whether the scene has an event node for `event`, or a JS app that
    hears it (config.json `events`)."""
    if not isinstance(scene, dict):
        return False
    for node in scene.get("nodes") or []:
        if isinstance(node, dict) and node.get("type") == "event" and (node.get("data") or {}).get("keyword") == event:
            return True
    for app in (scene.get("apps") or {}).values():
        sources = app.get("sources") if isinstance(app, dict) else None
        config = sources.get("config.json") if isinstance(sources, dict) else None
        try:
            hears = json.loads(config).get("events") if isinstance(config, str) else None
        except (ValueError, AttributeError):
            hears = None
        if isinstance(hears, list) and (event in hears or "*" in hears):
            return True
    return False


# --------------------------------------------------------------- the words

_LEAD = re.compile(
    r"^(?:(?:please|ok|okay|hey|so|and|then|now)[,]?\s+)*(?:(?:can|could|would) you\s+)?"
    r"(?:add|type|write|put|enter|insert|note(?: down)?|jot(?: down)?|create|make)"
    r"(?:\s+(?:a|an|the|another|one more))?(?:\s+new)?"
    r"(?:\s+(?:to-?dos?|todos?|items?|tasks?|entry|entries|notes?|memos?|lines?|reminders?))?"
    r"(?:\s+(?:called|saying|that says|named|for))?[:,]?\s+",
    re.IGNORECASE | re.ASCII,
)
_LEAD_NEW = re.compile(
    r"^(?:a\s+)?new\s+(?:to-?dos?|todos?|items?|tasks?|entry|notes?|memos?|reminders?)[:,]?\s+",
    re.IGNORECASE | re.ASCII,
)
_LEAD_SELF = re.compile(
    r"^(?:please\s+)?(?:remind me to|i need to|i have to|i must|don't forget to|do not forget to)\s+",
    re.IGNORECASE | re.ASCII,
)
_TAIL = re.compile(
    r"\s+(?:to|on|onto|in|into|at)\s+(?:the\s+|my\s+|this\s+)?(?:[\w-]+\s+){0,2}"
    r"(?:list|field|box|to-?dos?|todos?|notes?|input|form)$",
    re.IGNORECASE | re.ASCII,
)
_RENAME = re.compile(r"^(?:please\s+)?(?:rename|change|correct|replace)\s+.+?\s+(?:to|with|into)\s+(.+)$", re.IGNORECASE | re.ASCII)
_QUOTED = re.compile(r"[\"“‘']([^\"”’']{1,200})[\"”’']")


def _tidy(text: str) -> str:
    text = text.strip().strip(",;:").strip()
    if text.endswith(".") and not text.endswith("..") and text.count(".") == 1:
        text = text[:-1].rstrip()
    return text


def _capital(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def text_candidates(transcript: str) -> list[str]:
    """What the words to type could be: the whole utterance, and what is left
    of it without command words in front ("add", "type a new to-do") and a
    place behind ("to the list"), a rename's new name, a quoted part. Jev
    picks one; the first is always the utterance itself, tidied."""
    said = _tidy(transcript)
    out: list[str] = []

    def add(text: str) -> None:
        text = _tidy(text)
        if text and text not in out and len(out) < MAX_TEXT_CANDIDATES:
            out.append(text)

    add(said)
    renamed = _RENAME.match(said)
    if renamed:
        add(_capital(renamed.group(1)))
    for quoted in _QUOTED.findall(said):
        add(quoted)
    stripped = _LEAD.sub("", said, count=1)
    if stripped == said:
        stripped = _LEAD_NEW.sub("", said, count=1)
    if stripped == said:
        stripped = _LEAD_SELF.sub("", said, count=1)
    if stripped != said:
        add(_capital(stripped))
        tail = _TAIL.sub("", stripped)
        if tail != stripped:
            add(_capital(tail))
    tail_only = _TAIL.sub("", said)
    if tail_only != said:
        add(tail_only)
    return out


# --------------------------------------------------------------- the request


def _target_words(target: JsonObject) -> str:
    """How an element reads in an option: what it says or is called, the row
    it is on, and what it is."""
    label = target.get("label") or ""
    text = target.get("text") or ""
    if target["do"] == "type":
        words = f"Text field “{label}”" if label else "Text field"
        if text:
            words += f" that says “{text}”"
        if target.get("focus"):
            words += " (it has the keyboard)"
    else:
        what = label or text or "Unlabelled button"
        words = f"“{what}”" if what != "Unlabelled button" else what
        if label and text and text != label:
            words += f" (shows “{text}”)"
        if target["do"] == "pick":
            words += " (a list to pick from)"
    near = target.get("near")
    if near:
        words += f", on the row “{near}”"
    return words


def _event_words(event: JsonObject) -> str:
    words = event.get("description") or event["name"]
    if event.get("aliases"):
        words += " (also said as: " + ", ".join(event["aliases"]) + ")"
    return words


def _choice(instructions: str, criteria: dict[str, str]) -> JsonObject:
    return {"type": "choice", "instructions": instructions, "criteria": criteria}


def build_decision(
    *,
    transcript: str,
    screen: JsonObject,
    scene: JsonObject | None,
    scenes: list[JsonObject],
    model: str = JEV_MODEL,
) -> VoiceDecision:
    """The Jev request for what was said on this screen: the kinds of thing
    there is to do here, and for each one with a choice to make, its
    question, all in one request (Jev scores each on its own)."""
    targets = screen.get("targets") or []
    presses = [t for t in targets if t["do"] in ("tap", "pick")][:MAX_OPTIONS]
    fields = [t for t in targets if t["do"] == "type"][:MAX_OPTIONS]
    focused = next((t for t in fields if t.get("focus")), None)
    events, fallback = scene_voice_events(scene)
    actions = list(events)
    if scene_listens_for(scene, "back"):
        actions.append(BACK_ACTION)
    if scene_listens_for(scene, "forward"):
        actions.append(FORWARD_ACTION)
    actions = actions[:MAX_OPTIONS]
    showing = screen.get("scene")
    open_windows = screen.get("open") or []
    others = [s for s in scenes if s.get("id") != showing][:MAX_OPTIONS]

    decision = VoiceDecision(request={}, fallback=fallback)
    kinds: dict[str, str] = {}
    if screen.get("kb") and focused is not None:
        kinds[KIND_TYPE] = KIND_DESCRIPTIONS[KIND_TYPE]
        kinds[KIND_ENTER] = KIND_DESCRIPTIONS[KIND_ENTER]
    if fields:
        kinds[KIND_FILL] = KIND_DESCRIPTIONS[KIND_FILL]
    if presses:
        kinds[KIND_PRESS] = KIND_DESCRIPTIONS[KIND_PRESS]
    if actions:
        kinds[KIND_ACTION] = KIND_DESCRIPTIONS[KIND_ACTION] + ": " + "; ".join(_event_words(a) for a in actions)
    if others:
        kinds[KIND_SWITCH] = KIND_DESCRIPTIONS[KIND_SWITCH]
    kinds[KIND_SEVERAL] = KIND_DESCRIPTIONS[KIND_SEVERAL]
    kinds[KIND_OTHER] = KIND_DESCRIPTIONS[KIND_OTHER]
    if fallback is not None:
        kinds[KIND_FALLBACK] = "None of the above fits, so: " + _event_words(fallback)

    questions: JsonObject = {
        "kind": _choice(QUESTION_KIND, kinds),
        "several": {"type": "noul", "instructions": QUESTION_SEVERAL},
        "absent": {"type": "noul", "instructions": QUESTION_ABSENT},
    }
    if len(presses) > 1:
        criteria = {}
        for i, target in enumerate(presses):
            decision.targets[f"p{i}"] = target
            criteria[f"p{i}"] = _target_words(target)
        criteria[NONE_OPTION] = NONE_WORDS
        questions["press"] = _choice(QUESTION_PRESS, criteria)
    elif presses:
        decision.targets["p0"] = presses[0]
        questions["press"] = _choice(QUESTION_PRESS, {"p0": _target_words(presses[0]), NONE_OPTION: NONE_WORDS})
    if len(fields) > 1:
        criteria = {}
        for i, target in enumerate(fields):
            decision.targets[f"f{i}"] = target
            criteria[f"f{i}"] = _target_words(target)
        criteria[NONE_OPTION] = NONE_WORDS
        questions["field"] = _choice(QUESTION_FIELD, criteria)
    elif fields:
        decision.targets["f0"] = fields[0]
        questions["field"] = _choice(QUESTION_FIELD, {"f0": _target_words(fields[0]), NONE_OPTION: NONE_WORDS})
    if len(actions) > 1:
        criteria = {}
        for i, action in enumerate(actions):
            decision.actions[f"a{i}"] = action
            criteria[f"a{i}"] = _event_words(action)
        criteria[NONE_OPTION] = NONE_WORDS
        questions["action"] = _choice(QUESTION_ACTION, criteria)
    elif actions:
        decision.actions["a0"] = actions[0]
        questions["action"] = _choice(QUESTION_ACTION, {"a0": _event_words(actions[0]), NONE_OPTION: NONE_WORDS})
    if len(others) > 1:
        criteria = {}
        for i, other in enumerate(others):
            name = str(other.get("name") or other.get("id"))
            decision.scenes[f"s{i}"] = {"id": other.get("id"), "name": name}
            criteria[f"s{i}"] = name + (" (open in a window)" if other.get("id") in open_windows else "")
        criteria[NONE_OPTION] = NONE_WORDS
        questions["scene"] = _choice(QUESTION_SWITCH, criteria)
    elif others:
        decision.scenes["s0"] = {"id": others[0].get("id"), "name": str(others[0].get("name") or others[0].get("id"))}
        questions["scene"] = _choice(QUESTION_SWITCH, {"s0": decision.scenes["s0"]["name"], NONE_OPTION: NONE_WORDS})
    if fields:
        candidates = text_candidates(transcript)
        for i, text in enumerate(candidates):
            decision.words[f"w{i}"] = text
        if len(candidates) > 1:
            questions["words"] = _choice(QUESTION_WORDS, {f"w{i}": f"“{text}”" for i, text in enumerate(candidates)})
        questions["submit"] = {"type": "noul", "instructions": QUESTION_SUBMIT}
        if any(t.get("text") for t in fields):
            questions["replace"] = {"type": "noul", "instructions": QUESTION_REPLACE}

    state: JsonObject = {"said": transcript}
    current = next((s for s in scenes if s.get("id") == showing), None)
    if current is not None or scene is not None:
        state["scene"] = str((current or scene or {}).get("name") or showing or "")
    state["keyboard"] = "up" if screen.get("kb") else "down"
    state["screen"] = [_target_words(t) for t in targets[:MAX_OPTIONS]]
    decision.request = {"model": model, "state": state, "questions": questions}
    return decision


# ----------------------------------------------------------------- the plan


def _pick(answers: JsonObject, question: str, options: dict[str, Any]) -> tuple[str | None, float]:
    """The option a choice question picked and its probability; the only
    option, sure, for a question that was not asked (one option)."""
    if question not in answers:
        if len(options) == 1:
            return next(iter(options)), 1.0
        return None, 0.0
    answer = answers[question] or {}
    choice = answer.get("choice")
    probability = float((answer.get("probabilities") or {}).get(choice, 0.0)) if isinstance(choice, str) else 0.0
    return (choice if choice in options else None), probability


def _noul(answers: JsonObject, question: str) -> float:
    answer = answers.get(question) or {}
    value = answer.get("noul")
    return float(value) if isinstance(value, (int, float)) else 0.0


def _at(now: datetime) -> str:
    when = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _what(target: JsonObject) -> str:
    what = target.get("label") or target.get("text") or "it"
    near = target.get("near")
    return f"“{what}”" + (f" on “{near}”" if near else "")


def plan_from_answers(decision: VoiceDecision, answers: JsonObject, *, transcript: str, now: datetime) -> VoiceActionPlan | None:
    """What Jev's answers make the frame do, or None when the chat should
    decide: several things, something else, or an answer that is not sure."""
    kinds = decision.request["questions"]["kind"]["criteria"]
    kind, sure = _pick(answers, "kind", kinds)
    log: JsonObject = {"kind": kind, "p": round(sure, 3)}
    if kind is None or kind in (KIND_SEVERAL, KIND_OTHER) or sure < MIN_KIND_PROBABILITY:
        return None
    several, absent = _noul(answers, "several"), _noul(answers, "absent")
    if several >= SEVERAL_PROBABILITY:
        log["several"] = round(several, 3)
        return None
    if absent >= ABSENT_PROBABILITY and kind in (KIND_FILL, KIND_PRESS):
        log["absent"] = round(absent, 3)
        return None
    said = transcript.strip()[:MAX_EVENT_TEXT]

    if kind in (KIND_TYPE, KIND_ENTER):
        target = next((t for t in decision.targets.values() if t["do"] == "type" and t.get("focus")), None)
        if target is None:
            return None
        if kind == KIND_ENTER:
            log.update({"target": target["id"], "submit": True})
            return VoiceActionPlan(
                kind=kind,
                events=[{"name": "uiAction", "payload": {"target": target["id"], "do": "type", "text": "", "submit": True}}],
                reply=REPLY_PRESSED.format(what="Enter"),
                log=log,
            )
        word_key, _ = _pick(answers, "words", decision.words)
        text = decision.words.get(word_key or "w0", "")
        if not text:
            return None
        submit = _noul(answers, "submit") >= DICTATION_SUBMIT_PROBABILITY
        # Dictation goes on from what the field says, a space between.
        typed = (" " + text) if target.get("text") and not target["text"].endswith(" ") else text
        payload: JsonObject = {"target": target["id"], "do": "type", "text": typed}
        if submit:
            payload["submit"] = True
        log.update({"target": target["id"], "text": text, "submit": submit})
        return VoiceActionPlan(kind=kind, events=[{"name": "uiAction", "payload": payload}],
                               reply=(REPLY_ADDED if submit else REPLY_TYPED).format(text=text), log=log)

    if kind == KIND_FILL:
        fields = {k: t for k, t in decision.targets.items() if k.startswith("f")}
        key, target_p = _pick(answers, "field", fields)
        target = fields.get(key) if key else None
        word_key, _ = _pick(answers, "words", decision.words)
        text = decision.words.get(word_key or "w0", "")
        if target is None or target_p < MIN_TARGET_PROBABILITY or not text:
            return None
        submit = _noul(answers, "submit") >= SUBMIT_PROBABILITY
        replace = bool(target.get("text")) and _noul(answers, "replace") >= REPLACE_PROBABILITY
        payload = {"target": target["id"], "do": "set" if replace else "type", "text": text}
        if submit:
            payload["submit"] = True
        log.update({"target": target["id"], "text": text, "submit": submit, "replace": replace})
        reply = (REPLY_ADDED if submit else REPLY_TYPED).format(text=text)
        return VoiceActionPlan(kind=kind, events=[{"name": "uiAction", "payload": payload}], reply=reply, log=log)

    if kind == KIND_PRESS:
        presses = {k: t for k, t in decision.targets.items() if k.startswith("p")}
        key, target_p = _pick(answers, "press", presses)
        if key is None or target_p < MIN_TARGET_PROBABILITY:
            return None
        target = presses[key]
        log.update({"target": target["id"], "targetP": round(target_p, 3)})
        return VoiceActionPlan(
            kind=kind,
            events=[{"name": "uiAction", "payload": {"target": target["id"]}}],
            reply=REPLY_PRESSED.format(what=_what(target)),
            log=log,
        )

    if kind in (KIND_ACTION, KIND_FALLBACK):
        if kind == KIND_FALLBACK:
            action, target_p = decision.fallback, 1.0
        else:
            key, target_p = _pick(answers, "action", decision.actions)
            action = decision.actions.get(key) if key else None
        if action is None or target_p < MIN_TARGET_PROBABILITY:
            return None
        name = action["name"]
        payload = {} if name in ("back", "forward") else {"text": said, "at": _at(now)}
        log.update({"event": name})
        return VoiceActionPlan(
            kind=kind,
            events=[{"name": name, "payload": payload}],
            reply=REPLY_ACTION.format(what=(action.get("description") or name).rstrip(".")),
            log=log,
        )

    if kind == KIND_SWITCH:
        key, target_p = _pick(answers, "scene", decision.scenes)
        if key is None or target_p < MIN_TARGET_PROBABILITY:
            return None
        chosen = decision.scenes[key]
        log.update({"scene": chosen["id"]})
        return VoiceActionPlan(
            kind=kind,
            events=[{"name": "setCurrentScene", "payload": {"sceneId": chosen["id"]}}],
            reply=REPLY_SWITCHED.format(what=chosen["name"]),
            log=log,
        )
    return None


# ------------------------------------------------------------------ asking


class JevError(Exception):
    pass


async def ask_jev(request: JsonObject, *, api_key: str, http_client: httpx.AsyncClient | None = None) -> JsonObject:
    """Jev's answers ({question: answer}); raises JevError when it refused."""
    owns = http_client is None
    client = http_client or httpx.AsyncClient(timeout=JEV_TIMEOUT_SECONDS)
    try:
        response = await client.post(
            JEV_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            content=json.dumps(request),
            timeout=JEV_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        raise JevError(str(error)) from error
    finally:
        if owns:
            await client.aclose()
    if response.status_code >= 400:
        raise JevError(f"Jev refused ({response.status_code}): {response.text[:300]}")
    payload = response.json()
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        raise JevError("Jev answered without answers")
    return answers


AskJev = Callable[[JsonObject], Awaitable[JsonObject]]


@dataclass
class VoiceDecisionOutcome:
    plan: VoiceActionPlan | None
    decision: VoiceDecision
    answers: JsonObject | None
    seconds: float
    error: str | None = None


async def decide_voice_action(
    *,
    transcript: str,
    screen: JsonObject,
    scene: JsonObject | None,
    scenes: list[JsonObject],
    ask: AskJev,
    now: datetime | None = None,
) -> VoiceDecisionOutcome:
    """One utterance on one screen: the request, Jev's answers, the plan (None
    for the chat). A refused or failed Jev call is the chat's too."""
    decision = build_decision(transcript=transcript, screen=screen, scene=scene, scenes=scenes)
    started = time.monotonic()
    try:
        answers = await ask(decision.request)
    except (JevError, httpx.HTTPError, ValueError) as error:
        return VoiceDecisionOutcome(None, decision, None, time.monotonic() - started, str(error)[:300])
    plan = plan_from_answers(decision, answers, transcript=transcript, now=now or datetime.now(timezone.utc))
    return VoiceDecisionOutcome(plan, decision, answers, time.monotonic() - started)


# ------------------------------------------------------- the chat's tools

SCREEN_TOOL_DEFINITIONS: list[JsonObject] = [
    {
        "type": "function",
        "name": "press",
        "description": (
            "Press an element on the frame's screen, as a finger would: a button, an icon, a checkbox, an item. "
            "By its id from the context's \"On the screen\" list."
        ),
        "parameters": {
            "type": "object",
            "properties": {"target": {"type": "string", "description": "The element's id."}},
            "required": ["target"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "type_text",
        "description": (
            "Type words into a text field on the frame's screen, by its id from the context's \"On the screen\" "
            "list: at the end of what it says, or replacing it; with submit, Enter after (an item added, a form sent)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "The field's id."},
                "text": {"type": "string", "description": "The words to type, exactly."},
                "submit": {"type": "boolean", "description": "Press Enter after the words."},
                "replace": {"type": "boolean", "description": "Replace what the field says instead of adding to it."},
            },
            "required": ["target", "text"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "scene_action",
        "description": (
            "Do one of the showing scene's own actions (the context's \"Scene actions\"), by name. What was said "
            "goes with it as its text, unless text says otherwise."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The action's name."},
                "text": {"type": "string", "description": "The text it gets. Omit for what was said."},
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
]
SCREEN_TOOL_LABELS = {"press": "Press", "type_text": "Type text", "scene_action": "Scene action"}
MAX_SCREEN_EVENTS = 8


def screen_context_block(screen: JsonObject, scene: JsonObject | None) -> str:
    """What the chat is told of the screen: each element with the id its
    tools take, the keyboard, the scene's actions."""
    lines = ["On the screen (press and type_text take these ids):"]
    for target in screen.get("targets") or []:
        lines.append(f"- {target['id']}: {_target_words(target)}" + (" (scrolls)" if target.get("scroll") else ""))
    if len(lines) == 1:
        lines.append("- nothing to press or type into")
    lines.append(f"The on-screen keyboard is {'up' if screen.get('kb') else 'down'}.")
    events, fallback = scene_voice_events(scene)
    actions = list(events) + ([fallback] if fallback else [])
    if scene_listens_for(scene, "back"):
        actions.append(BACK_ACTION)
    if scene_listens_for(scene, "forward"):
        actions.append(FORWARD_ACTION)
    if actions:
        lines.append("Scene actions (scene_action takes these names):")
        lines.extend(f"- {a['name']}: {_event_words(a)}" for a in actions)
    return "\n".join(lines)


class VoiceScreenTools:
    """press / type_text / scene_action for the voice chat: each call adds
    the event the frame will dispatch to `events` (sent back in the reply, in
    order); nothing reaches the frame before the turn answers."""

    def __init__(self, *, screen: JsonObject, scene: JsonObject | None, transcript: str = "", now: datetime | None = None):
        self.screen = screen
        self.scene = scene
        self.transcript = transcript
        self.now = now or datetime.now(timezone.utc)
        self.events: list[JsonObject] = []
        events, fallback = scene_voice_events(scene)
        self._actions = {a["name"] for a in events} | ({fallback["name"]} if fallback else set())
        if scene_listens_for(scene, "back"):
            self._actions.add("back")
        if scene_listens_for(scene, "forward"):
            self._actions.add("forward")

    def target(self, target_id: Any) -> JsonObject | None:
        return next((t for t in self.screen.get("targets") or [] if t["id"] == target_id), None)

    def call(self, name: str, args: JsonObject) -> JsonObject:
        if len(self.events) >= MAX_SCREEN_EVENTS:
            return {"ok": False, "error": "too_many_actions"}
        if name == "press":
            target = self.target(args.get("target"))
            if target is None or target["do"] not in ("tap", "pick", "type"):
                return {"ok": False, "error": "unknown_target"}
            self.events.append({"name": "uiAction", "payload": {"target": target["id"]}})
            return {"ok": True, "pressed": _what(target)}
        if name == "type_text":
            target = self.target(args.get("target"))
            text = args.get("text")
            if target is None or target["do"] != "type":
                return {"ok": False, "error": "unknown_field"}
            if not isinstance(text, str) or not text.strip():
                return {"ok": False, "error": "text must say what to type"}
            payload: JsonObject = {"target": target["id"], "do": "set" if args.get("replace") is True else "type",
                                   "text": text.strip()[:MAX_EVENT_TEXT]}
            if args.get("submit") is True:
                payload["submit"] = True
            self.events.append({"name": "uiAction", "payload": payload})
            return {"ok": True, "typed": payload["text"]}
        if name == "scene_action":
            action = args.get("name")
            if action not in self._actions:
                return {"ok": False, "error": "unknown_action", "actions": sorted(self._actions)}
            if action in ("back", "forward"):
                payload = {}
            else:
                given = args.get("text")
                text = given if isinstance(given, str) and given.strip() else self.transcript
                payload = {"text": text.strip()[:MAX_EVENT_TEXT], "at": _at(self.now)}
            self.events.append({"name": action, "payload": payload})
            return {"ok": True, "action": action}
        return {"ok": False, "error": f"unknown tool {name}"}

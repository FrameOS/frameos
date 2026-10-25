"""Voice chat for ESP32 frames (docs/voice-chat.md): the frame streams what
the user says while they hold the voice key, this transcribes it and runs one
turn of the AI chat about that frame with a small frame-scoped toolset.

Three parts, each small:

- the session store: raw PCM chunks a frame POSTs while it records, kept in
  this process's memory (like the cloud's AI turns) until the chunk with
  `done=1` arrives, at most VOICE_MAX_AUDIO_BYTES (30 s) per session and
  VOICE_SESSION_TTL_SECONDS of silence;
- the transcription: OpenAI's /v1/audio/transcriptions on the PCM wrapped as
  a WAV, the frame's scene names as the prompt;
- the turn: the chat's own agent loop (app/utils/ai_chat_agent.py) with the
  voice system prompt, the frame's context block, and VoiceTools — the six
  tools a frame's own token may drive (list scenes, activate one, set the
  showing scene's state, redraw, show a picture, rotate), narrowed by the
  owner's three permission switches (VoicePermissions: change settings, use
  the installed scenes, put new scenes on the frame). Not the MCP server's
  tools: a frame's credential is not the owner's.

The cloud's copy is cloud/apps/auth-web/src/lib/ai/voice.ts: the prompt, the
tool definitions and the permission table are kept the same there."""
from __future__ import annotations

import asyncio
import io
import json
import re
import struct
import sys
import time
import uuid
from array import array
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from app.models.frame import Frame
from app.utils.ai_chat_agent import OpenAiRequestError, ToolBox, ToolOutput, build_initial_input, run_agent_loop
from app.utils.ai_chat_tools import untrusted_result

__all__ = [
    "VOICE_MAX_AUDIO_BYTES",
    "VOICE_MAX_CHUNK_BYTES",
    "VOICE_SESSION_TTL_SECONDS",
    "VOICE_SAMPLE_RATE_HZ",
    "VOICE_TOOL_DEFINITIONS",
    "VOICE_TOOL_PERMISSIONS",
    "VoicePermissions",
    "VoiceSessionStore",
    "VoiceTools",
    "VoiceTurnResult",
    "build_voice_system_prompt",
    "pcm_peak",
    "pcm_to_wav",
    "run_voice_turn",
    "transcribe_pcm",
    "transcript_is_hint_echo",
    "voice_chat_id",
]

VOICE_SAMPLE_RATE_HZ = 16000
VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE_HZ * 2
# The frame records 30 s at most (FOS_VOICE_MAX_SECONDS); the caps here
# mirror it so a leaked key cannot fill the process with audio.
VOICE_MAX_AUDIO_BYTES = 30 * VOICE_BYTES_PER_SECOND
VOICE_MAX_CHUNK_BYTES = 64 * 1024
VOICE_SESSION_TTL_SECONDS = 60
VOICE_SESSIONS_PER_FRAME_PER_15_MIN = 20
# The model that hears: OpenAI's small transcription model, priced per
# audio minute, fine on a sentence. Whisper-1 would do the same work.
TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions"
TRANSCRIPTION_TIMEOUT_SECONDS = 60.0
MAX_TRANSCRIPT_CHARS = 4000
MAX_VOICE_ROUNDS = 6
MAX_VOICE_HISTORY = 8


def voice_chat_id(frame_id: int) -> str:
    """The id the frame's voice chat is proposed under: one chat per frame,
    so "no, the other one" has the previous turn to refer to. The backend
    derives the stored id from it (project_chat_id)."""
    return f"voice:{frame_id}"


# ---------------------------------------------------------- permissions

# What the voice chat may do on this frame (docs/voice-chat.md "What the
# voice chat may do"): the owner's three switches. Plane-side policy, never a
# firmware setting: the planes decide which tools the turn is offered. The
# backend keeps them in device_config as `voiceChangeSettings` /
# `voiceUseScenes` / `voiceCreateScenes` (the device's settings poll does not
# carry them), the cloud in frames.voice_permissions. The cloud's copy is
# voice.ts (voiceToolPermissions, defaultVoicePermissions): keep both alike.
VOICE_PERMISSION_KEYS = ("change_settings", "use_scenes", "create_scenes")
DEFAULT_VOICE_PERMISSIONS = {"change_settings": True, "use_scenes": True, "create_scenes": False}
VOICE_PERMISSION_DEVICE_CONFIG_KEYS = {
    "change_settings": ("voiceChangeSettings", "voice_change_settings"),
    "use_scenes": ("voiceUseScenes", "voice_use_scenes"),
    "create_scenes": ("voiceCreateScenes", "voice_create_scenes"),
}
# Which switch each tool answers to. A tool not listed (list_scenes) is
# always offered: it reads, and it is what the model names when it must
# decline. show_image puts a scene the frame did not hold on the frame, so it
# is a new scene, not a use of an installed one.
VOICE_TOOL_PERMISSIONS = {
    "activate_scene": "use_scenes",
    "set_scene_state": "use_scenes",
    "render_now": "use_scenes",
    "show_image": "create_scenes",
    "rotate_frame": "change_settings",
}
# How the context names each switch to the model, on and off.
VOICE_PERMISSION_DESCRIPTIONS = {
    "change_settings": "change the frame's settings (rotate_frame)",
    "use_scenes": "use the installed scenes: switch between them, set their fields, redraw (activate_scene, set_scene_state, render_now)",
    "create_scenes": "put new scenes on the frame (show_image)",
}


@dataclass(frozen=True)
class VoicePermissions:
    change_settings: bool = True
    use_scenes: bool = True
    create_scenes: bool = False

    def allows(self, tool: str) -> bool:
        """Whether the turn may be offered (and may run) this tool."""
        key = VOICE_TOOL_PERMISSIONS.get(tool)
        return key is None or bool(getattr(self, key))

    def as_dict(self) -> dict[str, bool]:
        return {key: bool(getattr(self, key)) for key in VOICE_PERMISSION_KEYS}

    def context_lines(self) -> list[str]:
        """The two lines the frame's context block carries: what the owner
        allowed and what not, each naming its tools."""
        allowed = [VOICE_PERMISSION_DESCRIPTIONS[key] for key in VOICE_PERMISSION_KEYS if getattr(self, key)]
        denied = [VOICE_PERMISSION_DESCRIPTIONS[key] for key in VOICE_PERMISSION_KEYS if not getattr(self, key)]
        return [
            f"- Voice chat may: {'; '.join(allowed) if allowed else 'nothing but list the scenes'}",
            f"- Voice chat may not: {'; '.join(denied) if denied else 'nothing is switched off'}",
        ]

    @classmethod
    def from_device_config(cls, device_config: Any) -> "VoicePermissions":
        """The backend's spelling: camelCase first, the snake_case twin a USB
        provisioning might have left; anything but a bool is the default."""
        values = dict(DEFAULT_VOICE_PERMISSIONS)
        if isinstance(device_config, dict):
            for key, names in VOICE_PERMISSION_DEVICE_CONFIG_KEYS.items():
                for name in names:
                    if isinstance(device_config.get(name), bool):
                        values[key] = device_config[name]
                        break
        return cls(**values)

    @classmethod
    def from_frame(cls, frame: Frame) -> "VoicePermissions":
        return cls.from_device_config(frame.device_config)


# ------------------------------------------------------------- sessions


@dataclass
class VoiceSession:
    frame_id: int
    session_id: str
    chunks: list[bytes] = field(default_factory=list)
    next_seq: int = 0
    received: int = 0
    updated_at: float = field(default_factory=time.monotonic)

    def audio(self) -> bytes:
        return b"".join(self.chunks)


class VoiceSessionStore:
    """The audio of sessions still being spoken, per (frame, session id)."""

    def __init__(self, *, ttl_seconds: float = VOICE_SESSION_TTL_SECONDS, now: Callable[[], float] = time.monotonic):
        self._sessions: dict[tuple[int, str], VoiceSession] = {}
        self._ttl = ttl_seconds
        self._now = now

    def _sweep(self) -> None:
        now = self._now()
        for key in [key for key, session in self._sessions.items() if now - session.updated_at > self._ttl]:
            del self._sessions[key]

    def append(self, frame_id: int, session_id: str, seq: int, data: bytes) -> VoiceSession | str:
        """Add one chunk. Returns the session, or an error code: `seq_mismatch`
        (a gap or a repeat; the frame gives the session up), `session_too_long`
        (past the 30 s cap), `unknown_session` (a seq > 0 for a session this
        process never saw: a restart, or a wait longer than the TTL)."""
        self._sweep()
        key = (frame_id, session_id)
        session = self._sessions.get(key)
        if session is None:
            if seq != 0:
                return "unknown_session"
            session = VoiceSession(frame_id=frame_id, session_id=session_id)
            self._sessions[key] = session
        if seq != session.next_seq:
            del self._sessions[key]
            return "seq_mismatch"
        if session.received + len(data) > VOICE_MAX_AUDIO_BYTES:
            del self._sessions[key]
            return "session_too_long"
        if data:
            session.chunks.append(data)
            session.received += len(data)
        session.next_seq += 1
        session.updated_at = self._now()
        return session

    def take(self, frame_id: int, session_id: str) -> VoiceSession | None:
        """The finished session's audio: removed from the store, the audio
        is kept nowhere once the turn is over."""
        return self._sessions.pop((frame_id, session_id), None)

    def __len__(self) -> int:
        return len(self._sessions)


# ---------------------------------------------------------- transcription


# Below this peak (of 32767) nobody spoke: the bench E1002's MEMS microphone
# reads speech at arm's length in the thousands and a quiet room in the tens.
# A transcription of silence is not empty: the model echoes its prompt (the
# scene names, 2026-10-24 bench), so the gate sits before the call.
VOICE_SILENCE_PEAK = 250


def pcm_peak(pcm: bytes) -> int:
    """The loudest sample's magnitude, 0..32768."""
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder != "little":
        samples.byteswap()
    return max((abs(int(s)) for s in samples), default=0)


def _normalized_words(text: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", text.lower()))


def transcript_is_hint_echo(transcript: str, scene_names: list[str]) -> bool:
    """The transcription came back as the prompt it was given (the scene
    names, joined), which is what the model does with silence or noise."""
    if not scene_names:
        return False
    return _normalized_words(transcript) == _normalized_words(", ".join(scene_names))


def pcm_to_wav(pcm: bytes, sample_rate: int = VOICE_SAMPLE_RATE_HZ) -> bytes:
    """A 16-bit mono WAV around the frame's raw little-endian PCM."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        1,  # mono
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


async def transcribe_pcm(
    pcm: bytes,
    *,
    api_key: str,
    prompt: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> str:
    """What was said, as text. Raises OpenAiRequestError on a refused call."""
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=TRANSCRIPTION_TIMEOUT_SECONDS)
    try:
        data: dict[str, str] = {"model": TRANSCRIPTION_MODEL, "response_format": "json"}
        if prompt:
            data["prompt"] = prompt[:1000]
        response = await client.post(
            TRANSCRIPTION_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files={"file": ("speech.wav", io.BytesIO(pcm_to_wav(pcm)), "audio/wav")},
            timeout=TRANSCRIPTION_TIMEOUT_SECONDS,
        )
    finally:
        if owns_client:
            await client.aclose()
    if response.status_code >= 400:
        detail = response.text[:300]
        try:
            detail = str(response.json().get("error", {}).get("message") or detail)
        except Exception:  # noqa: BLE001 - the body is whatever came back
            pass
        raise OpenAiRequestError(f"Transcription failed ({response.status_code}): {detail}", response.status_code)
    payload = response.json()
    text = payload.get("text") if isinstance(payload, dict) else None
    return (text or "").strip()[:MAX_TRANSCRIPT_CHARS]


# ----------------------------------------------------------------- prompt


def build_voice_system_prompt() -> str:
    """Byte-stable (prompt caching); the frame goes in the input. The same
    text as the cloud's buildVoiceSystemPrompt (src/lib/ai/voice.ts)."""
    return """
You are the FrameOS voice assistant for one smart frame. The user held two buttons on the frame and spoke; their
message is a transcript of what they said. Transcripts carry recognition errors: read for the likely intent ("the
bird journal" is the scene called Bird Field Journal). Scene names in the frame's context are the ones to match.

Act, then answer in one short sentence. The reply is not shown on the frame and is read nowhere aloud: it lands in
the frame's chat log. Never ask for confirmation and never ask a question back: the spoken request is the
confirmation, and nobody is there to answer. Do the most likely thing; when nothing matches, say so and name what
the frame has (its scenes, from list_scenes). When the transcript is empty or not a request for the frame, say
briefly that you did not catch a request.

Tools: list_scenes (what the frame holds and which scene shows), activate_scene (switch to a scene by its id),
set_scene_state (set the showing scene's public fields, such as a message board's text), render_now (redraw the
frame), show_image (put a picture on the frame: a photo found for a search, or an image generated from a
description; the frame's context says which sources it has), rotate_frame (turn the display to 0, 90, 180 or 270
degrees; "another 90" is the rotation in the context plus 90). The owner chooses which of these the voice chat may
use: the context's "Voice chat may" and "may not" lines say which, and a tool you were not given is one the owner
switched off, so when asked for it say so in a sentence (it is a switch in the frame's settings) and do nothing else.
"Next" and "previous" mean the scene after or before the one showing, in list order, wrapping around. "Show me X"
with no scene of that name is show_image. These are the only things you can do; anything else (editing scenes,
timing, other frames, the account) is for the workspace, and you say so in a sentence.
""".strip()


# ------------------------------------------------------------------ tools

JsonObject = dict[str, Any]

VOICE_TOOL_DEFINITIONS: list[JsonObject] = [
    {
        "type": "function",
        "name": "list_scenes",
        "description": "The scenes on this frame, in order, with their ids and which one shows now.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "type": "function",
        "name": "activate_scene",
        "description": "Switch the frame to one of its scenes (an id from list_scenes or the context).",
        "parameters": {
            "type": "object",
            "properties": {"scene_id": {"type": "string", "description": "The scene's id."}},
            "required": ["scene_id"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "set_scene_state",
        "description": (
            "Set public fields of the scene the frame shows (its state), by field name, and redraw. "
            "Only fields the scene declares; strings, numbers and booleans."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "state": {
                    "type": "object",
                    "description": "Field name to value.",
                    "additionalProperties": {"type": ["string", "number", "boolean"]},
                }
            },
            "required": ["state"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "render_now",
        "description": "Redraw the frame now.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "type": "function",
        "name": "show_image",
        "description": (
            "Show a picture on the frame: a photo found for a search (source photo, Unsplash) or an image "
            "generated from a description (source generated, OpenAI). Pushes a one-picture preview scene to the "
            "frame and shows it; the frame's other scenes stay. Only the sources the context lists work."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to show: a search for a photo, or the description to generate from.",
                },
                "source": {
                    "type": "string",
                    "enum": ["photo", "generated"],
                    "description": "photo for a real photograph, generated for AI art. Omit to take the first the frame has.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "rotate_frame",
        "description": (
            "Turn the frame's display to an orientation: 0, 90, 180 or 270 degrees clockwise, absolute. "
            "The context says the current rotation; the frame restarts to apply a change."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "degrees": {"type": "integer", "enum": [0, 90, 180, 270], "description": "The new rotation, clockwise."},
            },
            "required": ["degrees"],
            "additionalProperties": False,
        },
    },
]

VOICE_TOOL_LABELS = {
    "list_scenes": "List scenes",
    "activate_scene": "Activate scene",
    "set_scene_state": "Set scene state",
    "render_now": "Render now",
    "show_image": "Show image",
    "rotate_frame": "Rotate frame",
}

MAX_STATE_BYTES = 16 * 1024
MAX_IMAGE_QUERY_CHARS = 400
# The contract's rule for the one setting the voice turn may change
# (docs/cloud-frames-contract.json `rotate`). The frame's render interval is
# deliberately not a voice tool: a frame sets its own, scenes have theirs, and
# a model given the key kept inventing `interval: 1` next to a rotation.
VOICE_ROTATIONS = (0, 90, 180, 270)

# Queue one command for the frame: the route's own queue helper (frames.py /
# embedded_commands.py), handed in so this module stays free of the API
# layer and a test can watch the calls.
QueueCommand = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
# Push scenes to the frame as a preview with one of them showing (the
# editor's "Preview on frame"), and change the frame's settings: the route's
# own, for the same reason.
PreviewScenes = Callable[[list[JsonObject], str], Awaitable[dict[str, Any]]]
UpdateSettings = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


# ------------------------------------------------------------ image scene

# The one-picture scene show_image pushes, per source: the repo image app it
# runs, the app field the spoken words go into, the settings group the app
# needs, and how long the picture stays before the scene fetches another (a
# day for a generated one: each render bills the account). The cloud builds
# the same scene (buildImageScene in voice.ts).
IMAGE_SCENE_SOURCES: dict[str, dict[str, Any]] = {
    "photo": {"origin": "repo/apps/image/unsplash", "keyword": "unsplash", "field": "search", "group": "unsplash", "seconds": 3600},
    "generated": {"origin": "repo/apps/image/openaiImage", "keyword": "openaiImage", "field": "prompt", "group": "openAI", "seconds": 86400},
}


def build_image_scene(*, source: str, query: str) -> JsonObject:
    """render event -> render/image (cover) fed by the source's app with the
    query in its field; the app bundled into the scene like the album scene
    (photo_album_scene.py)."""
    from app.utils.retired_apps import replacement_app_entry

    spec = IMAGE_SCENE_SOURCES[source]
    ids = {key: str(uuid.uuid4()) for key in ("event", "render", "app")}

    def edge(source_id: str, source_handle: str, target: str, target_handle: str, edge_type: str) -> JsonObject:
        return {"id": str(uuid.uuid4()), "source": source_id, "sourceHandle": source_handle, "target": target,
                "targetHandle": target_handle, "type": edge_type}

    return {
        "id": str(uuid.uuid4()),
        "name": f"Voice: {query}"[:60],
        "settings": {"backgroundColor": "#000000", "refreshInterval": spec["seconds"], "execution": "interpreted"},
        "fields": [],
        "nodes": [
            {"id": ids["event"], "type": "event", "data": {"keyword": "render"}, "position": {"x": -320, "y": 120}},
            {"id": ids["render"], "type": "app", "data": {"keyword": "render/image", "config": {"placement": "cover"}},
             "position": {"x": 200, "y": 140}},
            {"id": ids["app"], "type": "app",
             "data": {"keyword": spec["keyword"], "config": {spec["field"]: query},
                      "cache": {"enabled": True, "inputEnabled": True, "durationEnabled": True, "duration": str(spec["seconds"])}},
             "position": {"x": -260, "y": -200}},
        ],
        "edges": [
            edge(ids["event"], "next", ids["render"], "prev", "appNodeEdge"),
            edge(ids["app"], "fieldOutput", ids["render"], "fieldInput/image", "codeNodeEdge"),
        ],
        "apps": {spec["keyword"]: replacement_app_entry(spec["origin"])},
    }


def image_sources_for_settings(settings: dict[str, Any]) -> list[str]:
    """Which show_image sources this project's keys allow, photo first."""
    sources = []
    unsplash: dict[str, Any] = settings.get("unsplash") or {}
    if isinstance(unsplash, dict) and str(unsplash.get("accessKey") or "").strip():
        sources.append("photo")
    openai_settings: dict[str, Any] = settings.get("openAI") or {}
    if isinstance(openai_settings, dict) and str(openai_settings.get("apiKey") or "").strip():
        sources.append("generated")
    return sources


def validate_voice_settings(args: JsonObject) -> tuple[dict[str, Any] | None, str | None]:
    """The settings a voice tool may change (`rotate`, in the contract's
    spelling), checked against its rules; (None, error) when a value is off."""
    settings: dict[str, Any] = {}
    if "rotate" in args:
        rotate = args.get("rotate")
        if isinstance(rotate, bool) or not isinstance(rotate, (int, float)) or int(rotate) != rotate or int(rotate) not in VOICE_ROTATIONS:
            return None, "degrees must be 0, 90, 180 or 270"
        settings["rotate"] = int(rotate)
    if not settings:
        return None, "give degrees"
    return settings, None


class VoiceTools(ToolBox):
    """The frame-scoped tools, against this backend's command queue."""

    def __init__(
        self,
        *,
        frame: Frame,
        active_scene_id: str | None,
        queue_command: QueueCommand,
        preview_scenes: PreviewScenes | None = None,
        update_settings: UpdateSettings | None = None,
        image_sources: list[str] | None = None,
        permissions: VoicePermissions | None = None,
    ) -> None:
        self._frame = frame
        self._active_scene_id = active_scene_id
        self._queue = queue_command
        self._preview = preview_scenes
        self._update_settings = update_settings
        self._image_sources = list(image_sources or [])
        self.permissions = permissions or VoicePermissions()
        self.changed: list[str] = []

    def definitions(self) -> list[JsonObject]:
        # A tool the owner switched off is not offered at all; `call` refuses
        # it as well, for a model that names one from an earlier turn.
        return [tool for tool in VOICE_TOOL_DEFINITIONS if self.permissions.allows(str(tool["name"]))]

    def label(self, name: str) -> str:
        return VOICE_TOOL_LABELS.get(name, name)

    def scenes(self) -> list[JsonObject]:
        return [scene for scene in (self._frame.scenes or []) if isinstance(scene, dict) and scene.get("id")]

    async def call(self, name: str, args: JsonObject) -> ToolOutput:
        if name in VOICE_TOOL_PERMISSIONS and not self.permissions.allows(name):
            return ToolOutput(json.dumps({
                "ok": False,
                "error": "not_allowed",
                "detail": f"The owner has not allowed the voice chat to {VOICE_PERMISSION_DESCRIPTIONS[VOICE_TOOL_PERMISSIONS[name]]} on this frame. Say so; it is a switch in the frame's settings.",
            }))
        if name == "list_scenes":
            listing = [
                {
                    "id": scene.get("id"),
                    "name": scene.get("name") or "Untitled",
                    **({"default": True} if scene.get("default") else {}),
                    **({"showing": True} if scene.get("id") == self._active_scene_id else {}),
                }
                for scene in self.scenes()
            ]
            return ToolOutput(untrusted_result("frame_scenes", json.dumps({"scenes": listing})))
        if name == "activate_scene":
            scene_id = args.get("scene_id")
            scene = next((s for s in self.scenes() if s.get("id") == scene_id), None) if isinstance(scene_id, str) else None
            if scene is None:
                return ToolOutput(json.dumps({"ok": False, "error": "unknown_scene", "scenes": [s.get("id") for s in self.scenes()]}))
            outcome = await self._queue("set_current_scene", {"scene_id": scene_id})
            self.changed.append(name)
            return ToolOutput(json.dumps({"ok": outcome.get("status") != "failed", "scene": scene.get("name"), **outcome}))
        if name == "set_scene_state":
            state = args.get("state")
            if not isinstance(state, dict) or not state:
                return ToolOutput(json.dumps({"ok": False, "error": "state must be a non-empty object"}))
            if len(json.dumps(state)) > MAX_STATE_BYTES:
                return ToolOutput(json.dumps({"ok": False, "error": "state too large"}))
            outcome = await self._queue(
                "scene_event", {"name": "setSceneState", "payload": {"state": state, "render": True}}
            )
            self.changed.append(name)
            return ToolOutput(json.dumps({"ok": outcome.get("status") != "failed", **outcome}))
        if name == "render_now":
            outcome = await self._queue("render", {})
            self.changed.append(name)
            return ToolOutput(json.dumps({"ok": outcome.get("status") != "failed", **outcome}))
        if name == "show_image":
            query = str(args.get("query") or "").strip()[:MAX_IMAGE_QUERY_CHARS]
            source = args.get("source")
            if not query:
                return ToolOutput(json.dumps({"ok": False, "error": "query must say what to show"}))
            if not self._image_sources or self._preview is None:
                return ToolOutput(json.dumps({"ok": False, "error": "no_image_source",
                                              "detail": "This frame has no Unsplash or OpenAI image key; the workspace's Settings add one."}))
            if source not in IMAGE_SCENE_SOURCES:
                source = self._image_sources[0]
            if source not in self._image_sources:
                return ToolOutput(json.dumps({"ok": False, "error": "source_unavailable", "available": self._image_sources}))
            scene = build_image_scene(source=source, query=query)
            outcome = await self._preview([scene], str(scene["id"]))
            self.changed.append(name)
            return ToolOutput(json.dumps({"ok": outcome.get("status") != "failed", "source": source, "scene": scene["name"], **outcome}))
        if name == "rotate_frame":
            settings, error = validate_voice_settings({"rotate": args.get("degrees")})
            if settings is None or self._update_settings is None:
                return ToolOutput(json.dumps({"ok": False, "error": error or "settings cannot be changed from here"}))
            outcome = await self._update_settings(settings)
            self.changed.append(name)
            return ToolOutput(json.dumps({"ok": True, "settings": settings,
                                          **({"restart": True} if "rotate" in settings else {}), **outcome}))
        return ToolOutput(json.dumps({"ok": False, "error": f"unknown tool {name}"}))


# ------------------------------------------------------------------- turn


@dataclass
class VoiceTurnResult:
    transcript: str
    reply: str
    tools: list[str]


def voice_frame_context(
    frame: Frame,
    active_scene_id: str | None,
    frame_context: str,
    image_sources: list[str] | None = None,
    permissions: VoicePermissions | None = None,
) -> str:
    """The chat's frame context block, plus what the voice turn needs: which
    scene shows, the rotation, which picture sources the frame has, what the
    owner allowed the voice chat to do, and that the microphone brought the
    message."""
    lines = [frame_context]
    if active_scene_id:
        name = next(
            (s.get("name") for s in (frame.scenes or []) if isinstance(s, dict) and s.get("id") == active_scene_id),
            None,
        )
        lines.append(f"- Showing now: {untrusted_result('active_scene', json.dumps({'id': active_scene_id, 'name': name}))}")
    lines.append(f"- Rotation: {int(frame.rotate or 0)} degrees clockwise")
    lines.append(f"- Picture sources for show_image: {', '.join(image_sources) if image_sources else 'none'}")
    lines.extend((permissions or VoicePermissions()).context_lines())
    lines.append("The user spoke this into the frame's microphone; the message is the transcript.")
    return "\n".join(lines)


async def run_voice_turn(
    *,
    transcript: str,
    api_key: str,
    model: str,
    reasoning_effort: str | None,
    context_block: str,
    history: list[dict[str, str]],
    tools: VoiceTools,
    http_client: httpx.AsyncClient | None = None,
) -> VoiceTurnResult:
    """One turn: the loop's events go nowhere (no browser is reading), the
    result is what the frame gets back."""

    async def emit(event: dict[str, Any]) -> None:
        return None

    result = await run_agent_loop(
        api_key=api_key,
        model=model,
        reasoning_effort=reasoning_effort,
        instructions=build_voice_system_prompt(),
        input_items=build_initial_input(context_block, history[-MAX_VOICE_HISTORY:], transcript),
        tools=tools,
        emit=emit,
        http_client=http_client,
        max_rounds=MAX_VOICE_ROUNDS,
    )
    return VoiceTurnResult(transcript=transcript, reply=result.reply.strip() or "Done.", tools=list(result.tool_calls))


async def transcribe_and_answer(
    *,
    pcm: bytes,
    api_key: str,
    model: str,
    reasoning_effort: str | None,
    scene_names: list[str],
    context_block: str,
    history: list[dict[str, str]],
    tools: VoiceTools,
    http_client: httpx.AsyncClient | None = None,
) -> VoiceTurnResult | tuple[str, str]:
    """The whole answer to a finished session, or (error, detail) for the
    frame to sound as an error: `nothing_heard`, `transcription_failed`,
    `chat_failed`."""
    peak = pcm_peak(pcm)
    if peak < VOICE_SILENCE_PEAK:
        return "nothing_heard", f"silence (peak {peak})"
    try:
        transcript = await transcribe_pcm(
            pcm, api_key=api_key, prompt=", ".join(scene_names) if scene_names else None, http_client=http_client
        )
    except (OpenAiRequestError, httpx.HTTPError, asyncio.TimeoutError) as error:
        return "transcription_failed", str(error)
    transcript = transcript.strip()
    if not transcript:
        return "nothing_heard", "the transcription came back empty"
    if transcript_is_hint_echo(transcript, scene_names):
        return "nothing_heard", "only the scene names came back"
    try:
        return await run_voice_turn(
            transcript=transcript,
            api_key=api_key,
            model=model,
            reasoning_effort=reasoning_effort,
            context_block=context_block,
            history=history,
            tools=tools,
            http_client=http_client,
        )
    except (OpenAiRequestError, httpx.HTTPError, asyncio.TimeoutError) as error:
        return "chat_failed", str(error)

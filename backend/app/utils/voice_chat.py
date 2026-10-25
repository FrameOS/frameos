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
  voice system prompt, the frame's context block, the earlier exchanges with
  their actions (voice_history_for_model) and VoiceTools — the tools a
  frame's own token may drive (list scenes, activate one, set the showing
  scene's state, redraw, show a picture, build or change a scene with the
  scene AI as a sub-turn (voice_scene_builder.py), rotate) plus the two
  album tools (list the photo albums, show one), narrowed by the owner's four
  permission switches (VoicePermissions: change settings, use the installed
  scenes, put new scenes on the frame, play the photo albums). Not the MCP
  server's tools: a frame's credential is not the owner's;
- the log: every exchange is three rows of the frame's voice chat (what was
  heard, a `log` row of the tools that ran, the reply); the next turn reads
  them (voice_turn_log, voice_history_for_model).

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
from datetime import datetime, timedelta, timezone
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
    "VoiceAction",
    "build_voice_system_prompt",
    "describe_age",
    "voice_history_for_model",
    "voice_turn_log",
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


def voice_chat_id(frame_id: int) -> str:
    """The id the frame's voice chat is proposed under: one chat per frame,
    so "no, the other one" has the previous turn to refer to. The backend
    derives the stored id from it (project_chat_id)."""
    return f"voice:{frame_id}"


# ---------------------------------------------------------- permissions

# What the voice chat may do on this frame (docs/voice-chat.md "What the
# voice chat may do"): the owner's four switches. Plane-side policy, never a
# firmware setting: the planes decide which tools the turn is offered. The
# backend keeps them in device_config as `voiceChangeSettings` /
# `voiceUseScenes` / `voiceCreateScenes` / `voiceUseAlbums` (the device's
# settings poll does not carry them), the cloud in frames.voice_permissions.
# The cloud's copy is voice-permissions.ts (voiceToolPermissions,
# defaultVoicePermissions): keep both alike.
VOICE_PERMISSION_KEYS = ("change_settings", "use_scenes", "create_scenes", "use_albums")
DEFAULT_VOICE_PERMISSIONS = {"change_settings": True, "use_scenes": True, "create_scenes": False, "use_albums": True}
VOICE_PERMISSION_DEVICE_CONFIG_KEYS = {
    "change_settings": ("voiceChangeSettings", "voice_change_settings"),
    "use_scenes": ("voiceUseScenes", "voice_use_scenes"),
    "create_scenes": ("voiceCreateScenes", "voice_create_scenes"),
    "use_albums": ("voiceUseAlbums", "voice_use_albums"),
}
# Which switch each tool answers to. A tool not listed (list_scenes) is
# always offered: it reads, and it is what the model names when it must
# decline. show_image, create_scene and change_scene put a scene the frame did
# not hold on the frame, so they are new scenes, not a use of an installed one
# (change_scene's result is a preview copy; the installed scene stays). The album tools are the
# photo library's (docs/photos.md): listing it and playing a folder on the
# frame are one switch, since the listing is what names the folder.
VOICE_TOOL_PERMISSIONS = {
    "activate_scene": "use_scenes",
    "set_scene_state": "use_scenes",
    "render_now": "use_scenes",
    "show_image": "create_scenes",
    "create_scene": "create_scenes",
    "change_scene": "create_scenes",
    "rotate_frame": "change_settings",
    "list_albums": "use_albums",
    "show_album": "use_albums",
}
# How the context names each switch to the model, on and off.
VOICE_PERMISSION_DESCRIPTIONS = {
    "change_settings": "change the frame's settings (rotate_frame)",
    "use_scenes": "use the installed scenes: switch between them, set their fields, redraw (activate_scene, set_scene_state, render_now)",
    "create_scenes": "put new scenes on the frame (show_image, create_scene, change_scene)",
    "use_albums": "play the photo albums: list them, show one on the frame (list_albums, show_album)",
}


@dataclass(frozen=True)
class VoicePermissions:
    change_settings: bool = True
    use_scenes: bool = True
    create_scenes: bool = False
    use_albums: bool = True

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
You are the FrameOS voice assistant for one smart frame. The user held the frame's voice key and spoke; their
message is a transcript of what they said. Transcripts carry recognition errors: read for the likely intent ("the
bird journal" is the scene called Bird Field Journal). Scene names in the frame's context are the ones to match.

This is a conversation, not a row of one-off commands. The earlier exchanges are above, each with how long ago it
was and what you did then. A follow-up ("make the text bigger", "no, the other one", "a dog instead", "undo that")
refers to the latest exchange and to the scene it left on the frame; a request that stands on its own starts a new
topic. Exchanges from hours or days ago are background, not the thing being talked about now.

Act, then answer in one short sentence. The reply is drawn across the bottom of the frame for half a minute and
lands, with a log of what you did, in the frame's chat in the workspace. Never ask for confirmation and never ask a
question back: the spoken request is the confirmation, and the user can only speak again. Do the most likely thing;
when nothing matches, say so and name what the frame has (its scenes, from list_scenes). When the transcript is
empty or not a request for the frame, say briefly that you did not catch a request.

Tools: list_scenes (what the frame holds and which scene shows), activate_scene (switch to a scene by its id),
set_scene_state (set the showing scene's public fields, such as a message board's text), render_now (redraw the
frame), show_image (put a picture on the frame: a photo found for a search, or an image generated from a
description; the frame's context says which sources it has), create_scene (have the scene AI build a new scene from
a description: a clock, a weather board, a quote of the day, a countdown, anything a frame can show; it is checked
in the frame's own memory and shown on the frame as a preview the owner installs or discards in the workspace; it
takes a while, so say what you asked for), change_scene (have the scene AI change the scene the frame shows as
asked: bigger text, another color, one more line; the changed scene is shown as a preview the same way, and an
installed scene is never overwritten), rotate_frame (turn the display to 0, 90, 180 or 270 degrees; "another 90" is
the rotation in the context plus 90), list_albums (the photo albums in the owner's library, by path), show_album
(play an album on the frame: it makes a scene for the album, installs it next to the frame's scenes and shows it).
The owner chooses which of these the voice chat may use: the context's "Voice chat may" and "may not" lines say
which, and a tool you were not given is one the owner switched off, so when asked for it say so in a sentence (it is
a switch in the frame's settings) and do nothing else. "Next" and "previous" mean the scene after or before the one
showing, in list order, wrapping around. "Show me X" with no scene of that name is show_album when an album is called
that (list_albums tells), show_image when X is a picture, and create_scene when X is more than a picture (a clock, a
counter, a dashboard, text that updates). Pass create_scene and change_scene the request in full, in your own clear
words, with what the frame is (its size and colors are in the context). These are the only things you can do;
anything else (timing, other frames, the account) is for the workspace, and you say so in a sentence.
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
        "name": "create_scene",
        "description": (
            "Build a new scene from a description with the scene AI (what the workspace's AI scene button does): "
            "a clock, a weather board, a quote, a countdown, a dashboard. The scene is rendered in the frame's "
            "memory first and, when it draws, pushed to the frame as a preview the owner installs or discards in "
            "the workspace; the frame's other scenes stay. Takes up to a minute."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "request": {
                    "type": "string",
                    "description": "What the scene should show and look like, in full, in clear words.",
                },
                "name": {"type": "string", "description": "A short name for the scene. Omit to let the scene AI name it."},
            },
            "required": ["request"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "change_scene",
        "description": (
            "Change the scene the frame shows as asked, with the scene AI: bigger text, another color, one more "
            "line, a different layout. The changed scene is rendered in the frame's memory and pushed as a "
            "preview like create_scene's; an installed scene is never overwritten (its changed copy is the "
            "preview, with a new id). Takes up to a minute."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "request": {"type": "string", "description": "The change, in full, in clear words."},
            },
            "required": ["request"],
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
    {
        "type": "function",
        "name": "list_albums",
        "description": "The photo albums in the owner's library (docs/photos.md), by path, with how many photos each holds.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "type": "function",
        "name": "show_album",
        "description": (
            "Play a photo album on the frame: makes a scene that shows one photo of the album at a time, installs "
            "it next to the frame's scenes and shows it now (the same as Install photo scenes in the workspace). "
            "The album is a path from list_albums."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "The album's path, from list_albums."},
                "seconds": {"type": "number", "minimum": 1, "description": "How long each photo stays. Default 3600."},
                "order": {
                    "type": "string",
                    "enum": ["random", "sequential", "newest", "oldest"],
                    "description": "random (default) shows every photo once before any repeats.",
                },
            },
            "required": ["path"],
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
    "create_scene": "Create scene",
    "change_scene": "Change scene",
    "rotate_frame": "Rotate frame",
    "list_albums": "List albums",
    "show_album": "Show album",
}
MAX_ALBUM_PATH_CHARS = 1024
ALBUM_ORDERS = ("random", "sequential", "newest", "oldest")

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
# The photo library (docs/photos.md), the route's own too: the albums at the
# root as {path, name, items}, and the install of one on this frame (the
# work of the MCP's photo_album_install: the frame's share link, the album
# scene saved next to the frame's scenes, the switch).
ListAlbums = Callable[[], Awaitable[dict[str, Any]]]
InstallAlbum = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
# The scene AI as a sub-turn (app/utils/voice_scene_builder.py), the route's
# own: (request, the scene to change or None, a name or None) -> what came of
# it: {"ok": True, "scene": {...}, "summary": "..."} or {"ok": False,
# "error": ..., "detail": ...}. The tool pushes the scene as a preview.
BuildScene = Callable[[str, JsonObject | None, str | None], Awaitable[dict[str, Any]]]
MAX_SCENE_REQUEST_CHARS = 2000


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
        list_albums: ListAlbums | None = None,
        install_album: InstallAlbum | None = None,
        build_scene: BuildScene | None = None,
        preview_scene: JsonObject | None = None,
    ) -> None:
        self._frame = frame
        self._active_scene_id = active_scene_id
        self._build_scene = build_scene
        # The scene the frame shows for now without holding it (the voice
        # chat's or the editor's preview, docs/scene-previews.md): what
        # change_scene edits when it is the one showing.
        self._preview_scene = preview_scene
        self._queue = queue_command
        self._preview = preview_scenes
        self._update_settings = update_settings
        self._image_sources = list(image_sources or [])
        self._list_albums = list_albums
        self._install_album = install_album
        self.permissions = permissions or VoicePermissions()
        self.changed: list[str] = []
        self.actions: list[VoiceAction] = []

    def definitions(self) -> list[JsonObject]:
        # A tool the owner switched off is not offered at all; `call` refuses
        # it as well, for a model that names one from an earlier turn.
        return [tool for tool in VOICE_TOOL_DEFINITIONS if self.permissions.allows(str(tool["name"]))]

    def label(self, name: str) -> str:
        return VOICE_TOOL_LABELS.get(name, name)

    def scenes(self) -> list[JsonObject]:
        return [scene for scene in (self._frame.scenes or []) if isinstance(scene, dict) and scene.get("id")]

    def showing_scene(self) -> JsonObject | None:
        """The scene on the panel: the preview when it is the one showing (or
        when the device reports no scene the saved list holds), else the saved
        scene the device reports."""
        preview = self._preview_scene
        if preview is not None and (self._active_scene_id in (None, preview.get("id"))):
            return preview
        return next((s for s in self.scenes() if s.get("id") == self._active_scene_id), None)

    async def call(self, name: str, args: JsonObject) -> ToolOutput:
        output = await self._call(name, args)
        # Every call goes in the turn's log (voice_turn_log): the next
        # exchange's history, and the owner's record in the workspace.
        self.actions.append(VoiceAction(name=name, args=dict(args), result=action_result(output.text)))
        return output

    async def _call(self, name: str, args: JsonObject) -> ToolOutput:
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
        if name in ("create_scene", "change_scene"):
            request = str(args.get("request") or "").strip()[:MAX_SCENE_REQUEST_CHARS]
            if not request:
                return ToolOutput(json.dumps({"ok": False, "error": "request must say what the scene should show"}))
            if self._build_scene is None or self._preview is None:
                return ToolOutput(json.dumps({"ok": False, "error": "scene_ai_unavailable",
                                              "detail": "This frame's control plane cannot build scenes right now."}))
            base: JsonObject | None = None
            if name == "change_scene":
                base = self.showing_scene()
                if base is None:
                    return ToolOutput(json.dumps({"ok": False, "error": "no_scene_showing",
                                                  "detail": "The frame reports no scene to change; create_scene makes a new one."}))
                if base is not self._preview_scene:
                    # An installed scene is never overwritten: its changed copy
                    # is the preview, under a new id (one a saved scene holds
                    # would read as "installed", docs/scene-previews.md). The
                    # preview itself is replaced in place.
                    base = {key: value for key, value in base.items() if key != "default"}
                    base["id"] = str(uuid.uuid4())
            raw_name = args.get("name")
            scene_name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else None
            built = await self._build_scene(request, base, scene_name)
            if not built.get("ok") or not isinstance(built.get("scene"), dict):
                return ToolOutput(json.dumps({"ok": False, **{k: v for k, v in built.items() if k != "scene"}}))
            scene = built["scene"]
            outcome = await self._preview([scene], str(scene["id"]))
            self.changed.append(name)
            return ToolOutput(json.dumps({
                "ok": outcome.get("status") != "failed",
                "scene": scene.get("name"),
                "scene_id": scene.get("id"),
                **({"changed_from": base.get("name")} if base is not None else {}),
                **({"summary": built["summary"]} if isinstance(built.get("summary"), str) and built["summary"] else {}),
                "preview": True,
                **outcome,
            }))
        if name == "rotate_frame":
            settings, error = validate_voice_settings({"rotate": args.get("degrees")})
            if settings is None or self._update_settings is None:
                return ToolOutput(json.dumps({"ok": False, "error": error or "settings cannot be changed from here"}))
            outcome = await self._update_settings(settings)
            self.changed.append(name)
            return ToolOutput(json.dumps({"ok": True, "settings": settings,
                                          **({"restart": True} if "rotate" in settings else {}), **outcome}))
        if name == "list_albums":
            if self._list_albums is None:
                return ToolOutput(json.dumps({"ok": False, "error": "photos_unavailable"}))
            albums = await self._list_albums()
            if not albums.get("ok", True):
                return ToolOutput(json.dumps(albums))
            return ToolOutput(untrusted_result("photo_albums", json.dumps(albums)))
        if name == "show_album":
            path = str(args.get("path") or "").strip().strip("/")[:MAX_ALBUM_PATH_CHARS]
            if not path:
                return ToolOutput(json.dumps({"ok": False, "error": "path must name an album from list_albums"}))
            options: dict[str, Any] = {}
            seconds = args.get("seconds")
            if seconds is not None:
                if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not seconds >= 1:
                    return ToolOutput(json.dumps({"ok": False, "error": "seconds must be a number of at least 1"}))
                options["seconds"] = seconds
            order = args.get("order")
            if order is not None:
                if order not in ALBUM_ORDERS:
                    return ToolOutput(json.dumps({"ok": False, "error": f"order must be one of {', '.join(ALBUM_ORDERS)}"}))
                options["order"] = order
            if self._install_album is None:
                return ToolOutput(json.dumps({"ok": False, "error": "photos_unavailable"}))
            outcome = await self._install_album(path, options)
            if outcome.get("ok", True):
                self.changed.append(name)
            return ToolOutput(json.dumps({"ok": outcome.get("status") != "failed", **outcome}))
        return ToolOutput(json.dumps({"ok": False, "error": f"unknown tool {name}"}))


# ------------------------------------------------------------ the chat log

# How many earlier exchanges the model sees. Each is three rows in the chat
# (what was heard, what was done, what was answered), so the window is
# counted in turns, not rows.
MAX_VOICE_HISTORY_TURNS = 6
MAX_HISTORY_ACTION_CHARS = 400
# The row the turn's actions are kept on (the workspace draws a `log` row as
# a log bubble under the frame's chat, docs/ai-chat.md).
VOICE_LOG_TOOL = "log"
VOICE_TURN_TOOL = "voice"


@dataclass
class VoiceAction:
    """One tool call of a turn, as the log keeps it: the name, the arguments
    the model sent (cut), and what came of it (cut)."""

    name: str
    args: JsonObject
    result: JsonObject | str

    def line(self) -> str:
        args = json.dumps(self.args, ensure_ascii=False)
        if len(args) > MAX_HISTORY_ACTION_CHARS:
            args = args[:MAX_HISTORY_ACTION_CHARS] + "…"
        result = self.result if isinstance(self.result, str) else json.dumps(_action_outcome(self.result), ensure_ascii=False)
        if len(result) > MAX_HISTORY_ACTION_CHARS:
            result = result[:MAX_HISTORY_ACTION_CHARS] + "…"
        return f"{self.name} {args} -> {result}"


# What a tool result is worth remembering: the outcome, never the listing
# (list_scenes' scenes, an album list) that the next turn gets fresh anyway.
_ACTION_RESULT_KEYS = ("ok", "error", "detail", "scene", "scene_id", "source", "settings", "album", "summary", "preview", "changed_from", "status")


def _action_outcome(result: JsonObject) -> JsonObject:
    # An outcome ({"ok": ...}) keeps its telling keys; a listing's counts
    # (action_result) are kept whole.
    if "ok" not in result:
        return result
    return {key: result[key] for key in _ACTION_RESULT_KEYS if result.get(key) is not None}


def action_result(text: str) -> JsonObject | str:
    """A tool's output as the log keeps it: the outcome object as it is, a
    listing (an untrusted_result wrapper around {"scenes": [...]}) as the
    counts of what was listed — the next turn gets the frame's scenes fresh
    in its context, and the notice is not worth a line per turn."""
    body = text.strip()
    if body.startswith("<untrusted_data"):
        inner = body.split(">", 1)[1].rsplit("</untrusted_data>", 1)[0].strip()
        # The wrapper is the notice, then the data on its own line.
        data = inner.rsplit("\n", 1)[-1]
        try:
            listed = json.loads(data)
        except ValueError:
            return re.sub(r"\s+", " ", data)[:MAX_HISTORY_ACTION_CHARS]
        if isinstance(listed, dict):
            return {key: (f"{len(value)} listed" if isinstance(value, list) else value) for key, value in listed.items()}
        return f"{len(listed)} listed" if isinstance(listed, list) else str(listed)[:MAX_HISTORY_ACTION_CHARS]
    if body.startswith("{"):
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    return re.sub(r"\s+", " ", body)[:MAX_HISTORY_ACTION_CHARS]


def voice_turn_log(actions: list[VoiceAction], *, session_id: str, seconds: float, at: datetime) -> str:
    """The `log` row's text: one header line, then one line per tool call.
    Readable in the workspace's chat, parsed back by voice_history_for_model."""
    header = f"Voice chat turn at {at.strftime('%Y-%m-%d %H:%M:%S')} UTC, session {session_id}, {seconds:.1f} s"
    lines = [action.line() for action in actions] or ["(no tools ran)"]
    return "\n".join([header, *lines])


def describe_age(delta: timedelta) -> str:
    seconds = max(0, int(delta.total_seconds()))
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        minutes = seconds // 60
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"
    if seconds < 86400:
        hours = seconds // 3600
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    days = seconds // 86400
    return f"{days} day{'s' if days != 1 else ''} ago"


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def voice_history_for_model(
    rows: list[dict[str, Any]], *, now: datetime, max_turns: int = MAX_VOICE_HISTORY_TURNS
) -> list[dict[str, str]]:
    """The earlier exchanges as the model sees them, oldest first: each is the
    user's transcript and the assistant's reply, the reply followed by a
    bracketed note with how long ago the exchange was and the actions of the
    turn (the `log` row's lines), so "make it bigger" has the scene the last
    turn built to refer to. `rows` are the chat's messages, oldest first, as
    {role, content, tool, created_at (datetime)}. Rows of the workspace's own
    chat (no `voice` tool) are kept as plain text. The same shape as the
    cloud's voiceHistoryForModel (voice.ts)."""
    turns: list[dict[str, Any]] = []
    for row in rows:
        role = row.get("role")
        tool = row.get("tool")
        content = str(row.get("content") or "")
        if role == "user":
            turns.append({"user": content, "at": row.get("created_at"), "actions": None, "assistant": None})
            continue
        if not turns:
            turns.append({"user": None, "at": row.get("created_at"), "actions": None, "assistant": None})
        turn = turns[-1]
        if tool == VOICE_LOG_TOOL:
            turn["actions"] = content.split("\n")[1:]
        elif role == "assistant" and content.strip() and tool != "error":
            turn["assistant"] = content
    out: list[dict[str, str]] = []
    for turn in turns[-max_turns:]:
        if turn["user"]:
            out.append({"role": "user", "content": turn["user"]})
        notes: list[str] = []
        at = turn.get("at")
        if isinstance(at, datetime):
            when = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
            notes.append(describe_age(now - when))
        actions = turn.get("actions")
        if actions is not None:
            notes.append("Actions: " + ("; ".join(a for a in actions if a) or "none"))
        reply = turn["assistant"] or ""
        if notes:
            reply = f"{reply}\n\n[{'. '.join(notes)}]".strip()
        if reply:
            out.append({"role": "assistant", "content": reply})
    return out


# ------------------------------------------------------------------- turn


@dataclass
class VoiceTurnResult:
    transcript: str
    reply: str
    tools: list[str]
    actions: list[VoiceAction] = field(default_factory=list)


def voice_frame_context(
    frame: Frame,
    active_scene_id: str | None,
    frame_context: str,
    image_sources: list[str] | None = None,
    permissions: VoicePermissions | None = None,
    preview: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> str:
    """The chat's frame context block, plus what the voice turn needs: which
    scene shows, the preview standing on the frame (the scene it shows for
    now without holding it: `frame_commands.scene_preview_info`, with the
    `scene` the preview push kept), the rotation, which picture sources the
    frame has, what the owner allowed the voice chat to do, and that the
    microphone brought the message."""
    lines = [frame_context]
    preview_id = preview.get("scene_id") if isinstance(preview, dict) else None
    if isinstance(preview, dict) and preview_id:
        at = _parse_iso(preview.get("at"))
        ago = f", {describe_age((now or datetime.now(timezone.utc)) - at)}" if at else ""
        source = "the voice chat" if preview.get("source") == "voice" else "the scene editor"
        lines.append(
            "- Preview on the frame (shown for now, not installed; change_scene edits it when it is the one showing): "
            + untrusted_result("scene_preview", json.dumps({"id": preview_id, "name": preview.get("name")}))
            + f" from {source}{ago}"
        )
    showing_id = active_scene_id or (preview_id if preview_id else None)
    if showing_id:
        name = next(
            (s.get("name") for s in (frame.scenes or []) if isinstance(s, dict) and s.get("id") == showing_id),
            preview.get("name") if isinstance(preview, dict) and showing_id == preview_id else None,
        )
        lines.append(f"- Showing now: {untrusted_result('active_scene', json.dumps({'id': showing_id, 'name': name}))}")
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
        input_items=build_initial_input(context_block, history[-(2 * MAX_VOICE_HISTORY_TURNS):], transcript),
        tools=tools,
        emit=emit,
        http_client=http_client,
        max_rounds=MAX_VOICE_ROUNDS,
    )
    return VoiceTurnResult(
        transcript=transcript, reply=result.reply.strip() or "Done.", tools=list(result.tool_calls), actions=list(tools.actions)
    )


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

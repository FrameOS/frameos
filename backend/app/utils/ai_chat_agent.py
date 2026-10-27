"""The AI chat's agent loop (docs/ai-chat.md): one streaming OpenAI Responses
call at a time, executing the tool calls between rounds, forwarding text
deltas and tool activity to the browser as they happen.

A port of the cloud's loop (cloud/apps/auth-web/src/lib/ai/loop.ts and
openai.ts). Both planes speak the same NDJSON events to the same chatLogic in
the SPA, so an event added here is added there and in
frontend/src/utils/aiChatStream.ts."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from app.utils.photo_share_links import PhotoLinkRedactor

logger = logging.getLogger(__name__)

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
OPENAI_IDLE_TIMEOUT_SECONDS = 120.0
DEFAULT_REASONING_EFFORT = "low"
# Model rounds one reply may take: the cloud's loop.ts keeps the same number.
# A scene built, rendered, fixed and rendered again is well past a dozen.
MAX_TOOL_ROUNDS = 40

OUT_OF_STEPS_REPLY = 'I ran out of steps for this reply before finishing. Say "continue" and I will pick up where I stopped.'


def out_of_steps_note(max_rounds: int) -> str:
    """The last round of a reply that used them all: tools off, so the model
    says where it stopped instead of the reply ending mid-work."""
    return (
        f"You have used all {max_rounds} steps one reply may take, so you cannot call tools now. "
        "In a few sentences tell the user what you did, what state it is in, and what is left; "
        'they can say "continue" for you to pick up where you stopped.'
    )

PHOTO_LINK_NOTE = (
    "Photos album share links in this conversation are shown with placeholder tokens "
    "(pk_photo_link_1, pk_photo_link_2, ...). Keep each one exactly as it is: the real link is put back "
    "in every scene you deliver or save."
)

Emit = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class ToolOutput:
    text: str
    # data: URLs (data:image/png;base64,...) the model sees next to the text.
    images: list[str] = field(default_factory=list)


@dataclass
class AgentResult:
    reply: str
    tool: str
    rounds: int
    tool_calls: list[str]


class ToolBox:
    """What the loop needs of the tools: their definitions in the Responses
    function format, a label for the activity log, and a way to run one."""

    def definitions(self) -> list[dict[str, Any]]:  # pragma: no cover - interface
        raise NotImplementedError

    def label(self, name: str) -> str:  # pragma: no cover - interface
        return name

    async def call(self, name: str, args: dict[str, Any]) -> ToolOutput:  # pragma: no cover - interface
        raise NotImplementedError

    @property
    def delivered_tool(self) -> str | None:
        return None


class OpenAiRequestError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def model_supports_reasoning(model: str) -> bool:
    return re.match(r"^(gpt-[5-9]|o[0-9])", model) is not None


def user_message(text: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"type": "input_text", "text": text}]}


def assistant_message(text: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"type": "output_text", "text": text}]}


def function_call_output(text: str, images: list[str]) -> str | list[dict[str, Any]]:
    """A tool result for the model: plain text, or text and the images the tool
    produced. High detail: the point of looking is clipped text and cramped
    layouts, which a 512 px thumbnail hides."""
    if not images:
        return text
    return [
        {"type": "input_text", "text": text},
        *({"type": "input_image", "detail": "high", "image_url": image} for image in images),
    ]


def build_initial_input(context_block: str, history: list[dict[str, str]], prompt: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if context_block.strip():
        items.append(user_message(f"Context for this conversation:\n\n{context_block.strip()}"))
    for entry in history:
        content = entry.get("content") or ""
        if not content.strip():
            continue
        items.append(user_message(content) if entry.get("role") == "user" else assistant_message(content))
    items.append(user_message(prompt))
    return items


@dataclass
class StreamedResponse:
    output: list[dict[str, Any]]
    function_calls: list[dict[str, Any]]
    status: str


async def stream_response(
    *,
    client: httpx.AsyncClient,
    api_key: str,
    model: str,
    instructions: str,
    input_items: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    reasoning_effort: str | None,
    on_text_delta: Callable[[str], Awaitable[None]],
    on_call_progress: Callable[[str, int], Awaitable[None]] | None = None,
    tool_choice: str | None = None,
) -> StreamedResponse:
    body: dict[str, Any] = {
        "model": model,
        "instructions": instructions,
        "input": input_items,
        "tools": tools,
        "store": False,
        "stream": True,
    }
    if tool_choice:
        # "none": a text answer, the tools still defined (the input holds the
        # model's earlier calls to them).
        body["tool_choice"] = tool_choice
    if model_supports_reasoning(model):
        body["reasoning"] = {"effort": reasoning_effort or DEFAULT_REASONING_EFFORT}
        # store:false tool loops must round-trip the reasoning items.
        body["include"] = ["reasoning.encrypted_content"]

    completed: StreamedResponse | None = None
    failure: str | None = None
    calls_in_progress: dict[str, list[Any]] = {}

    async def handle(event: dict[str, Any]) -> None:
        nonlocal completed, failure
        kind = event.get("type")
        if kind == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str) and delta:
                await on_text_delta(delta)
        elif kind == "response.output_item.added":
            item = event.get("item") or {}
            if item.get("type") == "function_call" and isinstance(item.get("id"), str):
                calls_in_progress[item["id"]] = [item.get("name") or "", 0]
                if on_call_progress:
                    await on_call_progress(item.get("name") or "", 0)
        elif kind == "response.function_call_arguments.delta":
            progress = calls_in_progress.get(event.get("item_id") or "")
            if progress is not None and isinstance(event.get("delta"), str):
                progress[1] += len(event["delta"])
                if on_call_progress:
                    await on_call_progress(progress[0], progress[1])
        elif kind in ("response.completed", "response.incomplete"):
            payload = event.get("response") or {}
            raw_output = payload.get("output")
            output = [item for item in raw_output if isinstance(item, dict)] if isinstance(raw_output, list) else []
            completed = StreamedResponse(
                output=output,
                function_calls=[item for item in output if item.get("type") == "function_call"],
                status=payload.get("status") or "completed",
            )
        elif kind == "response.failed":
            failure = ((event.get("response") or {}).get("error") or {}).get("message") or "OpenAI response failed"
        elif kind == "error":
            failure = event.get("message") if isinstance(event.get("message"), str) else "OpenAI stream error"

    timeout = httpx.Timeout(OPENAI_IDLE_TIMEOUT_SECONDS, connect=30.0)
    async with client.stream(
        "POST",
        OPENAI_RESPONSES_URL,
        json=body,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=timeout,
    ) as response:
        if response.status_code >= 400:
            raw = await response.aread()
            detail = f"OpenAI request failed with status {response.status_code}"
            try:
                message = (json.loads(raw).get("error") or {}).get("message")
                if message:
                    detail = message
            except ValueError:
                pass
            if response.status_code == 404:
                detail = f'Model "{model}" was not found by OpenAI. Check the model name in Settings -> OpenAI.'
            raise OpenAiRequestError(detail, response.status_code)
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if line == "":
                if data_lines:
                    raw_event = "\n".join(data_lines)
                    data_lines = []
                    if raw_event.strip() and raw_event.strip() != "[DONE]":
                        try:
                            await handle(json.loads(raw_event))
                        except ValueError:
                            pass
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if data_lines:
            try:
                await handle(json.loads("\n".join(data_lines)))
            except ValueError:
                pass
    if failure:
        raise RuntimeError(failure)
    if completed is None:
        raise RuntimeError("OpenAI stream ended without a completed response")
    return completed


def format_bytes(count: int) -> str:
    if count < 1024:
        return f"{count} B"
    return f"{count / 1024:.1f} KB" if count < 10 * 1024 else f"{count / 1024:.0f} KB"


def parse_tool_arguments(raw: Any) -> dict[str, Any] | str:
    """The call's arguments, or an error string when they are not a JSON object."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as error:
        return (
            f"The arguments of this call were not valid JSON ({error}), so the tool did not run. "
            "Send the call again with complete, valid JSON arguments."
        )
    if not isinstance(parsed, dict):
        return "The arguments of this call must be a JSON object; the tool did not run."
    return parsed


async def run_agent_loop(
    *,
    api_key: str,
    model: str,
    reasoning_effort: str | None,
    instructions: str,
    input_items: list[dict[str, Any]],
    tools: ToolBox,
    emit: Emit,
    http_client: httpx.AsyncClient | None = None,
    max_rounds: int = MAX_TOOL_ROUNDS,
) -> AgentResult:
    # A Photos share link is a credential for a whole album: the model sees a
    # placeholder, and the calls it makes get the real link back.
    photo_links = PhotoLinkRedactor()
    input_items[:] = photo_links.redact(input_items)
    photo_links_noted = photo_links.size > 0
    if photo_links_noted:
        input_items.insert(max(0, len(input_items) - 1), user_message(PHOTO_LINK_NOTE))

    reply = ""
    rounds = 0
    tool_calls: list[str] = []
    definitions = tools.definitions()
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient()

    async def on_text_delta(delta: str) -> None:
        nonlocal reply
        reply += delta
        await emit({"type": "delta", "text": delta})

    try:
        for _ in range(max_rounds):
            rounds += 1
            reported: dict[str, int] = {}

            async def on_call_progress(name: str, count: int) -> None:
                last = reported.get(name, -1)
                if count != 0 and count - last < 4096:
                    return
                reported[name] = count
                await emit({
                    "type": "tool",
                    "name": name,
                    "label": tools.label(name),
                    "status": "progress",
                    "detail": "writing…" if count == 0 else f"{format_bytes(count)} written",
                })

            response = await stream_response(
                client=client,
                api_key=api_key,
                model=model,
                instructions=instructions,
                input_items=input_items,
                tools=definitions,
                reasoning_effort=reasoning_effort,
                on_text_delta=on_text_delta,
                on_call_progress=on_call_progress,
            )
            if not response.function_calls:
                return AgentResult(reply=reply, tool=tools.delivered_tool or "reply", rounds=rounds, tool_calls=tool_calls)

            input_items.extend(response.output)
            for call in response.function_calls:
                name = call.get("name") or ""
                label = tools.label(name)
                tool_calls.append(name)
                await emit({"type": "tool", "name": name, "label": label, "status": "start"})
                images: list[str] = []
                parsed = parse_tool_arguments(call.get("arguments"))
                if isinstance(parsed, str):
                    output = json.dumps({"ok": False, "error": parsed})
                    await emit({
                        "type": "tool",
                        "name": name,
                        "label": label,
                        "status": "error",
                        "detail": "arguments were not valid JSON",
                    })
                else:
                    try:
                        result = await tools.call(name, photo_links.restore(parsed))
                        output = result.text
                        images = result.images
                        await emit({"type": "tool", "name": name, "label": label, "status": "done"})
                    except Exception as error:  # a tool failing is the model's to read, not the turn's end
                        detail = str(error) or error.__class__.__name__
                        output = json.dumps({"error": detail})
                        await emit({"type": "tool", "name": name, "label": label, "status": "error", "detail": detail})
                input_items.append({
                    "type": "function_call_output",
                    "call_id": call.get("call_id"),
                    "output": function_call_output(photo_links.redact_text(output), images),
                })
            if not photo_links_noted and photo_links.size > 0:
                input_items.append(user_message(PHOTO_LINK_NOTE))
                photo_links_noted = True

        # Out of rounds mid-tool-use: one more round with the tools off, so the
        # model tells the user what it did and what is left. It used to end on
        # a canned line asking for "a narrower request" (2026-10-27).
        reply_before_wrap_up = len(reply)
        if reply.strip():
            await on_text_delta("\n\n")
        input_items.append(user_message(out_of_steps_note(max_rounds)))
        rounds += 1
        try:
            await stream_response(
                client=client,
                api_key=api_key,
                model=model,
                instructions=instructions,
                input_items=input_items,
                tools=definitions,
                reasoning_effort=reasoning_effort,
                on_text_delta=on_text_delta,
                tool_choice="none",
            )
        except Exception:
            logger.exception("ai chat: the out-of-steps summary round failed")
    finally:
        if owns_client:
            await client.aclose()

    if not reply[reply_before_wrap_up:].strip():
        reply += OUT_OF_STEPS_REPLY
        await emit({"type": "delta", "text": OUT_OF_STEPS_REPLY})
    return AgentResult(reply=reply, tool=tools.delivered_tool or "reply", rounds=rounds, tool_calls=tool_calls)

import json
from typing import Any

from app.config import config
from app.utils.ai_scene import _build_ai_posthog_properties, _new_ai_span_id, _openai_client

APP_CHAT_ROUTER_SYSTEM_PROMPT = """
You are a router that decides how to handle a FrameOS app chat request.
Choose exactly one tool:
- edit_app: The user wants changes to the app's source files.
- ask_about_app: The user is asking about how the app works or wants guidance.
Return JSON only with:
- tool: one of "edit_app", "ask_about_app"
- tool_prompt: a concise prompt for the chosen tool (or the original user request if no rewrite is needed)
Rules:
- Use edit_app when the user asks to change, add, fix, refactor, or optimize the app code or config.
- Use ask_about_app for explanations, diagnostics, or how-to questions about the app.
""".strip()

APP_EDIT_SYSTEM_PROMPT = """
You are editing a FrameOS app written in Nim. You have access to the Nim version 2.2 STL and the following nimble packages:
pixie v5, chrono 0.3.1, checksums 0.2.1, ws 0.5.0, psutil 0.6.0, QRGen 3.1.0, zippy 0.10, chroma 0.2.7, bumpy 1.1.2

Return the modified files in full with the changes inlined. Only modify what is necessary.
Return JSON only with:
- reply: a brief summary of the changes.
- files: an object mapping filenames to their full updated contents (only include files you changed).

Make these changes:
""".strip()

APP_EDIT_FILES_PROMPT = """
-------------
Here are the relevant files of the app:
""".strip()

APP_CHAT_ANSWER_SYSTEM_PROMPT = """
You are a friendly assistant for FrameOS apps.
Answer questions about the current app or how to edit it.
Use the provided app sources and context.
Provide helpful context without overwhelming the user; keep replies concise unless they ask for specifics.
Limit answers to a few short paragraphs (2-3 max) and avoid long lists unless the user asks.
If the answer is uncertain, say what is missing and how to proceed.
Return JSON only with the key "answer".
""".strip()


def _format_app_sources(sources: dict[str, str]) -> str:
    entries = []
    for file, content in sources.items():
        entries.append(f"# {file}\n```\n{content}\n```")
    return "\n\n\n-------\n\n".join(entries)


def _format_app_context(app_name: str | None, app_keyword: str | None, scene_id: str | None, node_id: str | None) -> str:
    parts = []
    if app_name:
        parts.append(f"App name: {app_name}")
    if app_keyword:
        parts.append(f"App keyword: {app_keyword}")
    if scene_id:
        parts.append(f"Scene id: {scene_id}")
    if node_id:
        parts.append(f"Node id: {node_id}")
    return "\n".join(parts)


async def route_app_chat(
    *,
    prompt: str,
    app_name: str | None,
    app_keyword: str | None,
    scene_id: str | None,
    node_id: str | None,
    history: list[dict[str, str]] | None,
    api_key: str,
    model: str,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
) -> dict[str, Any]:
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    context_lines = _format_app_context(app_name, app_keyword, scene_id, node_id)
    user_prompt = prompt if not context_lines else f"{context_lines}\n\nUser request: {prompt}"
    messages = [{"role": "system", "content": APP_CHAT_ROUTER_SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_prompt})
    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=None,
            extra={"operation": "route_app_chat"},
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


async def answer_app_question(
    *,
    prompt: str,
    sources: dict[str, str],
    app_name: str | None,
    app_keyword: str | None,
    scene_id: str | None,
    node_id: str | None,
    history: list[dict[str, str]] | None,
    api_key: str,
    model: str,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
) -> dict[str, Any]:
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    context_lines = _format_app_context(app_name, app_keyword, scene_id, node_id)
    sources_block = _format_app_sources(sources)
    user_prompt = "\n\n".join(
        [
            line
            for line in [
                context_lines or None,
                prompt,
                APP_EDIT_FILES_PROMPT,
                sources_block,
            ]
            if line
        ]
    )
    messages = [{"role": "system", "content": APP_CHAT_ANSWER_SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_prompt})
    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=None,
            extra={"operation": "answer_app_question"},
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


async def edit_app_sources(
    *,
    prompt: str,
    sources: dict[str, str],
    app_name: str | None,
    app_keyword: str | None,
    scene_id: str | None,
    node_id: str | None,
    history: list[dict[str, str]] | None,
    api_key: str,
    model: str,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
) -> dict[str, Any]:
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    context_lines = _format_app_context(app_name, app_keyword, scene_id, node_id)
    sources_block = _format_app_sources(sources)
    user_prompt = "\n\n".join(
        [
            line
            for line in [
                context_lines or None,
                prompt,
                APP_EDIT_FILES_PROMPT,
                sources_block,
            ]
            if line
        ]
    )
    messages = [{"role": "system", "content": APP_EDIT_SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append(
        {
            "role": "user",
            "content": user_prompt,
        }
    )
    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=None,
            extra={"operation": "edit_app_sources"},
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)

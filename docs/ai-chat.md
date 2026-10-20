# The AI chat

One assistant, on both control planes, everywhere the workspace offers AI:
the AI box on the frames home, the AI box above a frame's scenes, the chat
drawer in the scene and app editors, and "Generate scene" in Add scene. It can
answer from live data ("what's on the kitchen frame right now?"), change frames
and their settings, build and edit scenes (split scenes included), and explain
FrameOS — with the same tools on the self-hosted backend and on FrameOS Cloud.

## One protocol

The browser posts a turn and reads NDJSON back, one event per line:

| Plane | Endpoint |
|---|---|
| Cloud | `POST /api/ai/chat` (`app/api/ai/chat/route.ts`) |
| Backend | `POST /api/projects/{id}/ai/chat` (`backend/app/api/ai_chat.py`) |

Request: `{prompt, chatId, frameId?, sceneId?, scene?, selectedNodes?,
selectedEdges?, history, renderSize?, timeZone?, editor?}`. `frameId` is
absent for a chat about no frame in particular (the frames home's AI box);
`editor: false` says there is no scene editor to deliver into.

Events (`ChatStreamEvent` in `cloud/apps/auth-web/src/lib/ai/loop.ts`, the
backend's `run_agent_loop`, `CloudAiChatEvent` in
`frontend/src/utils/cloudAiChat.ts`):

- `chat {chatId, turnId?}` — first. `chatId` is the id the chat is stored
  under; the browser re-keys the chat it named to it (the backend derives a
  per-project id, `project_chat_id`). Only the cloud sends `turnId`: its turns
  run detached and a dropped stream is resumed at
  `GET /api/ai/chat/turns/{turnId}?after=N`. A backend turn also outlives its
  stream (its reply lands on the chat) but cannot be re-attached to.
- `delta {text}` — reply text as it streams.
- `tool {name, label, status: progress|start|done|error, detail?}` — the
  activity log under the reply.
- `scenes {tool: build_scene|modify_scene, title?, scenes}` — a scene for the
  editor, applied unsaved (the user presses Save).
- `proposal {...}` — cloud only: an Install card for `add_scene_to_frame`.
- `done {tool, reply}` / `error {detail}` — last.
- `ping` — keepalive, ignored.

`frontend/src/scenes/frame/panels/Chat/chatLogic.ts` reads it on both planes.
After a `scenes` event the browser renders the scene once in the wasm preview
and sends runtime errors back as an automatic follow-up (`[Automatic render
check]`), at most twice per message; a preview runtime that never started is
skipped, not reported.

## One agent loop, two implementations

Both planes run the same loop: a streaming OpenAI Responses call, the tool
calls it makes, their results (text, and images for anything that looks at a
frame) fed back, until the model answers without calling a tool. The cloud's is
TypeScript (`src/lib/ai/loop.ts`, `openai.ts`), the backend's a port of it
(`backend/app/utils/ai_chat_agent.py`). Photos share links are swapped for
placeholders before anything reaches the model on both
(`share-links-in-scenes.ts`, `photo_share_links.py`).

## The tools: the MCP server's, plus the editor's

The chat has every tool its plane's MCP server has (`docs/mcp.md`,
`cloud/packages/mcp`), run in-process for the signed-in user — a tool added to
the MCP server is a tool the chat has. The calls go to the plane's own routes
with the chat request's own credential (backend: `build_server` over ASGI with
the request's cookie or bearer; cloud: `connectInProcessMcp` with the session
cookie and the Origin the request passed the CSRF check with, or its API
token), so permissions, limits and validation are the routes' as for any MCP
client. Tools that change a frame keep their `confirm: true` gate: the prompt
tells the model to pass it only when the user asked for that change.

Left out on both (`EXCLUDED_MCP_TOOLS` in `ai_chat_tools.py` and
`mcp-tools.ts`): the AI tools (a chat inside the chat), API tokens, and
deleting frames; on the cloud also revoking frames and minting claim tokens.

Next to them, the editor tools: `create_scenes`, `update_scene`,
`patch_scene`, `edit_app_source` (deliver to the editor, after validation) and
`render_scene` (look at a scene: the cloud's headless wasm renderer,
`scene-render.ts`; the backend's `embedded_render.py`, when Node and the wasm
build are present). With `editor: false`, `create_scenes` points the model at
`scene_create` / `frame_scene_install` instead. The cloud keeps its own extra
tools too (catalog and doc search, store, `save_scene`, `add_scene_to_frame`).

`patch_scene` and `edit_app_source` must merge identically on both planes:
`docs/ai-scene-patch-fixtures.json` is replayed by
`cloud/apps/auth-web/src/lib/ai/scene-patch-fixtures.test.ts` and
`backend/app/api/tests/test_ai_chat.py`. Change one implementation, change the
other and the fixtures.

Every tool result that carries text somebody else wrote is wrapped in
`<untrusted_data source="…">` with the same notice on both planes.

## The prompt

`cloud/apps/auth-web/src/lib/ai/prompts.ts` and
`backend/app/utils/ai_chat_prompt.py`: the same shape and rules, each naming
its own plane's tools. Both end with the scene guide (`docs/scene-guide.md`).
Byte-stable across requests (prompt caching); per-request context — the
frame, the open scene, the selection — goes in the input. A rule that matters
to both goes in both.

## The UI

`AiPromptBox` (`frontend/src/scenes/workspace/AiPromptBox.tsx`): the frames
home's top bar (where the search was) and above a frame's scenes on its
overview. Example questions cycle in its placeholder (Tab takes one), and
Enter calls `workspaceLogic.startAiChat(frameId | null, prompt)`, which opens
the chat drawer with the question already sent. The drawer for `frameId: null`
(`?drawer=chat` on any page) is the frames home's chat: it lists the chats that
are about no frame.

## Settings

Backend: Settings → OpenAI, `backendApiKey`, `chatModel` (else `model`, else
the default) and `chatReasoningEffort`. Cloud: the account's own key, or the
shared operator key under the daily cap (`src/lib/ai/api-key.ts`).

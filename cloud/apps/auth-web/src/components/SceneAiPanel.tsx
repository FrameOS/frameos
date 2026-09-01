"use client";

import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  Play,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import posthog from "posthog-js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AiChatRequestError,
  AiChatTransportError,
  formatElapsed,
  stopAiChatTurn,
  streamAiChat,
  type AiChatHistoryItem,
  type AiListingChanges,
} from "../lib/ai-chat-client";
import type { AiScenesEvent, SceneJson } from "../lib/ai-scenes-apply";
import { renderSceneCheck } from "../lib/scene-render-check";

export const RENDER_CHECK_PREFIX = "[Automatic render check]";
export const MAX_RENDER_CHECK_ROUNDS = 2;
const MAX_HISTORY_ITEMS = 12;
/** Rendered-frame previews kept in the transcript (each is a full PNG). */
export const MAX_RENDER_PREVIEWS = 6;

export const existingSceneSuggestions = [
  "Change the colour scheme",
  "Make the text bigger and bolder",
  "Add today's date in a corner",
  "Rearrange for a portrait 480×800 panel",
  "Explain what this scene does",
];

export const newSceneSuggestions = [
  "A minimal clock with the date underneath",
  "Today's weather for Berlin with a big temperature",
  "A daily quote on a soft gradient background",
  "A countdown to New Year's Eve",
];

type ToolLine = {
  key: string;
  name: string;
  label: string;
  // progress = the model is still writing the call; start = it is running.
  status: "progress" | "start" | "done" | "error";
  detail?: string | undefined;
};

const isOpen = (line: ToolLine) => line.status === "start" || line.status === "progress";

// History recovery after a lost stream: how often and how long to look for
// the persisted reply of a turn that kept running server-side.
const RECOVERY_POLL_MS = 20 * 1000;
const RECOVERY_POLL_ATTEMPTS = 12;

/** The frame the render check drew, ready for an <img>, together with the
 * scenes it was drawn from — "Show in preview" runs exactly those. */
type RenderPreview = {
  src: string;
  width: number;
  height: number;
  scenes: SceneJson[];
  sceneId: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** A render-check feedback turn the panel sent on the user's behalf. */
  auto?: boolean;
  tools?: ToolLine[];
  streaming?: boolean;
  stopped?: boolean;
  error?: string | null;
  /** Outcome of the in-browser render check, once it ran. */
  check?: { ok: boolean; text: string } | null;
  /** What the render check drew; dropped from older messages to bound memory. */
  preview?: RenderPreview | null;
};

type FatalState =
  | { kind: "login_required" }
  | { kind: "missing_api_key" }
  // The account switched AI off (403): nothing is broken, they asked.
  | { kind: "ai_disabled" }
  // Today's spend is at the cap (402): back tomorrow on its own. `shared`
  // when the cap was the operator's free allowance, which is not money the
  // account owes and must not be described as their limit.
  | { kind: "daily_cap_reached"; resetAt: string | null; shared: boolean }
  | { kind: "rate_limited" }
  | { kind: "error"; message: string };

export type SceneAiPanelProps = {
  /** The store scene being viewed/edited, if any. */
  storeSceneId?: string | undefined;
  /** The editor's LATEST scenes (the editor reports edits debounced). */
  getScenes: () => SceneJson[] | null;
  selectedSceneId?: string | null | undefined;
  width: number;
  height: number;
  /** Apply a scenes event to the editor. May return the id of the scene it
   * ended up selecting, which the render check then targets. */
  onScenes: (event: AiScenesEvent) => void | string | null;
  signedIn: boolean;
  /** The account switched AI features off (Account → AI usage). Known before
   * the first turn, so the panel says so up front instead of accepting a
   * prompt and refusing it after the round trip. */
  aiDisabled?: boolean | undefined;
  /** Where to go to turn AI back on. */
  aiSettingsUrl?: string | undefined;
  /** Submitted as the first turn as soon as the panel mounts (signed in), or
   * pre-filled into the prompt box (signed out). */
  initialPrompt?: string | undefined;
  suggestions?: string[] | undefined;
  /** Whether the editor holds an existing scene or a brand-new blank one;
   * picks the default suggestions and placeholder. */
  mode?: "existing" | "new" | undefined;
  /** Where the OpenAI key is set (the fleet workspace's settings page). */
  settingsUrl?: string | undefined;
  /** The sign-in page; `return_to` is appended. */
  loginUrl?: string | undefined;
  /** One line telling the user where their saves go. */
  saveHint?: string | undefined;
  /** The draft's listing as the editor holds it, sent with each turn. */
  getListing?: (() => AiListingChanges | null) | undefined;
  /** The AI edited the listing (description, tags, category, minimum
   * FrameOS version): applied to the draft like scenes, published by Save. */
  onListing?: ((changes: AiListingChanges) => void) | undefined;
  /** A conversation to reopen (a restored draft): the transcript as it was,
   * and the chat it belongs to so the next turn continues it. */
  initialChat?: AiChatSnapshot | undefined;
  /** The transcript changed, as much of it as is worth keeping — text only,
   * no rendered frames (each is a full PNG). */
  onChatChange?: ((chat: AiChatSnapshot) => void) | undefined;
  /** Offered under a rendered frame as "Show in preview": run exactly the
   * scenes that frame was drawn from in the Preview panel. */
  onShowInPreview?: ((snapshot: RenderedScenes) => void) | undefined;
};

/** A transcript worth storing: what the panel can be handed back later. */
export type AiChatSnapshot = {
  chatId: string;
  messages: { role: "user" | "assistant"; content: string; auto?: boolean }[];
};

/** The scenes behind one rendered frame in the transcript. */
export type RenderedScenes = { scenes: SceneJson[]; sceneId: string };

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function historyFromMessages(messages: ChatMessage[]): AiChatHistoryItem[] {
  return messages
    .filter((message) => message.content.trim() && !message.error && !message.streaming)
    .map((message) => ({ content: message.content.trim(), role: message.role }))
    .slice(-MAX_HISTORY_ITEMS);
}

function formatCheckFeedback(errors: string[], rendered: boolean): string {
  const reported = errors.slice(0, 8);
  return (
    `${RENDER_CHECK_PREFIX} The scene rendered${rendered ? "" : " no image and"} with these errors:\n` +
    reported.map((error) => `- ${error}`).join("\n") +
    (errors.length > reported.length ? `\n(and ${errors.length - reported.length} more)` : "") +
    "\nPlease fix the scene so it renders without errors and deliver the corrected version."
  );
}

// Attaches the preview to `id` and drops previews from older messages past
// MAX_RENDER_PREVIEWS, keeping their status text.
type RecoveredTurn = {
  content: string;
  tool: string | null;
  scenes: SceneJson[] | null;
};

// Poll the chat history for the assistant reply of a turn whose stream was
// lost for good. Resolves through `apply` at most once; `cancel` stops it.
function recoverFromHistory({
  chatId,
  since,
  apply,
  pollMs = RECOVERY_POLL_MS,
  attempts = RECOVERY_POLL_ATTEMPTS,
}: {
  chatId: string;
  since: number;
  apply: (recovered: RecoveredTurn) => void;
  pollMs?: number;
  attempts?: number;
}): { cancel: () => void } {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async (remaining: number) => {
    if (cancelled) {
      return;
    }
    try {
      const response = await fetch(`/api/ai/chats/${encodeURIComponent(chatId)}`);
      if (response.ok) {
        const payload = (await response.json()) as {
          messages?: {
            role: string;
            content: string;
            createdAt: string;
            tool?: string | null;
            payload?: { delivered?: unknown } | null;
          }[];
        };
        const reply = [...(payload.messages ?? [])]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.tool !== "error" &&
              Date.parse(message.createdAt) >= since - 60 * 1000,
          );
        if (reply && !cancelled) {
          const delivered = reply.payload?.delivered;
          apply({
            content: reply.content,
            scenes: Array.isArray(delivered) && delivered.length > 0 ? (delivered as SceneJson[]) : null,
            tool: reply.tool ?? null,
          });
          return;
        }
      }
    } catch {
      // try again below
    }
    if (remaining > 1 && !cancelled) {
      timer = setTimeout(() => void attempt(remaining - 1), pollMs);
    }
  };
  timer = setTimeout(() => void attempt(attempts), pollMs);
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}

function withPreview(messages: ChatMessage[], id: string, preview: RenderPreview | null): ChatMessage[] {
  const next = messages.map((message) => (message.id === id ? { ...message, preview } : message));
  let kept = 0;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index]!;
    if (!message.preview) {
      continue;
    }
    if (kept < MAX_RENDER_PREVIEWS) {
      kept += 1;
    } else {
      next[index] = { ...message, preview: null };
    }
  }
  return next;
}

function blobUrlFromDataUrl(dataUrl: string): string | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl);
  if (!match || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  try {
    const binary = atob(match[1]!);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    return null;
  }
}

// Browsers refuse top-frame navigation to data: URLs, so a click opens the
// same bytes as a blob: URL; the href stays for copy-link and hover.
function openRenderPreview(event: MouseEvent<HTMLAnchorElement>, src: string): void {
  const url = blobUrlFromDataUrl(src);
  if (!url) {
    return;
  }
  event.preventDefault();
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function RenderPreviewImage({ preview }: { preview: RenderPreview }) {
  return (
    <a
      className="ai-panel__render-link"
      href={preview.src}
      onClick={(event) => openRenderPreview(event, preview.src)}
      rel="noopener"
      target="_blank"
      title="Open the rendered frame in a new tab"
    >
      <img
        alt="Rendered preview of the scene"
        className="ai-panel__render"
        height={preview.height}
        src={preview.src}
        width={preview.width}
      />
    </a>
  );
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-description ai-panel__markdown">
      <ReactMarkdown
        components={{
          a: ({ children, href, node, ...props }) => {
            void node;
            const external = href?.startsWith("https://") || href?.startsWith("http://");
            return (
              <a {...props} href={href} {...(external ? { rel: "noreferrer", target: "_blank" } : {})}>
                {children}
              </a>
            );
          },
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function ToolActivity({ tools, streaming }: { tools: ToolLine[]; streaming: boolean }) {
  if (tools.length === 0) {
    return null;
  }
  const last = tools[tools.length - 1]!;
  const summary =
    streaming && isOpen(last)
      ? `${last.label}${last.status === "progress" && last.detail ? ` (${last.detail})` : ""}…`
      : `${tools.length} step${tools.length === 1 ? "" : "s"}`;
  return (
    <details className="ai-panel__tools">
      <summary className="ai-panel__tools-summary">
        {streaming && isOpen(last) ? (
          <Loader2 aria-hidden className="ai-panel__spin" size={13} />
        ) : null}
        {summary}
      </summary>
      <ul className="ai-panel__tool-list">
        {tools.map((tool) => (
          <li
            className={
              tool.status === "error"
                ? "ai-panel__tool ai-panel__tool--error"
                : "ai-panel__tool"
            }
            key={tool.key}
          >
            {isOpen(tool) ? (
              <Loader2 aria-hidden className="ai-panel__spin" size={12} />
            ) : tool.status === "error" ? (
              <AlertTriangle aria-hidden size={12} />
            ) : (
              <Check aria-hidden size={12} />
            )}
            <span>
              {tool.label}
              {(tool.status === "error" || tool.status === "progress") && tool.detail
                ? ` — ${tool.detail}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// The AI chat column of the scene editor: a transcript, streaming replies,
// tool activity, and the scenes the agent delivers, applied to the editor
// through onScenes. State stays in React — this app doesn't use kea.
export function SceneAiPanel({
  aiDisabled = false,
  aiSettingsUrl,
  storeSceneId,
  getScenes,
  selectedSceneId,
  width,
  height,
  onScenes,
  signedIn,
  initialPrompt,
  suggestions,
  mode = "existing",
  settingsUrl,
  loginUrl = "/login",
  saveHint,
  getListing,
  onListing,
  initialChat,
  onChatChange,
  onShowInPreview,
}: SceneAiPanelProps) {
  // A restored draft reopens its transcript (message ids are ours, not the
  // server's, so they are minted fresh) and keeps its chat id, so the next
  // turn continues the same conversation server-side.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    (initialChat?.messages ?? []).map((message) => ({
      content: message.content,
      id: newId(),
      role: message.role,
      ...(message.auto ? { auto: true } : {}),
    })),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [fatal, setFatal] = useState<FatalState | null>(null);
  const [chatId, setChatId] = useState<string>(() => initialChat?.chatId || newId());
  const [returnTo, setReturnTo] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  // The server-side turn behind the in-flight request (for Stop + recovery).
  const turnIdRef = useRef<string | null>(null);
  const recoveryRef = useRef<{ cancel: () => void } | null>(null);
  const busyRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const chatIdRef = useRef(chatId);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  messagesRef.current = messages;
  chatIdRef.current = chatId;

  // Always the freshest props for the in-flight turn (it spans awaits).
  const propsRef = useRef({ getListing, getScenes, height, mode, onListing, onScenes, selectedSceneId, storeSceneId, width });
  propsRef.current = { getListing, getScenes, height, mode, onListing, onScenes, selectedSceneId, storeSceneId, width };

  useEffect(() => {
    setReturnTo(window.location.href);
  }, []);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, status]);

  // The transcript, handed to whoever wants to keep it (the new-scene page
  // stores it with its draft). Settled messages only, and text only: the
  // rendered frames are megabytes of PNG and are not worth storing.
  const onChatChangeRef = useRef(onChatChange);
  onChatChangeRef.current = onChatChange;
  const storedChatRef = useRef("");
  useEffect(() => {
    const handler = onChatChangeRef.current;
    if (!handler) {
      return;
    }
    const snapshot: AiChatSnapshot = {
      chatId,
      messages: messages
        .filter((message) => message.content.trim() && !message.streaming && !message.error)
        .map((message) => ({
          content: message.content,
          role: message.role,
          ...(message.auto ? { auto: true } : {}),
        })),
    };
    const json = JSON.stringify(snapshot);
    if (snapshot.messages.length === 0 || json === storedChatRef.current) {
      return;
    }
    storedChatRef.current = json;
    handler(snapshot);
  }, [messages, chatId]);

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id
          ? { ...message, ...(typeof patch === "function" ? patch(message) : patch) }
          : message,
      ),
    );
  }, []);

  const submit = useCallback(
    async (rawPrompt: string, round = 0): Promise<void> => {
      const prompt = rawPrompt.trim();
      if (!prompt || busyRef.current || !signedIn || aiDisabled) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setFatal(null);
      setStatus(null);
      turnIdRef.current = null;
      recoveryRef.current?.cancel();
      recoveryRef.current = null;
      const turnStartedAt = Date.now();

      const history = historyFromMessages(messagesRef.current);
      const userMessage: ChatMessage = {
        auto: prompt.startsWith(RENDER_CHECK_PREFIX),
        content: prompt,
        id: newId(),
        role: "user",
      };
      const assistantId = newId();
      setMessages((current) => [
        ...current,
        userMessage,
        { content: "", id: assistantId, role: "assistant", streaming: true, tools: [] },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      const { getScenes: readScenes, onScenes: applyScenes, selectedSceneId: selected, storeSceneId: storeId } =
        propsRef.current;
      const editorScenes = readScenes() ?? [];
      const draftListing = propsRef.current.getListing?.() ?? null;
      const targetScene =
        editorScenes.find((scene) => scene.id === selected) ?? editorScenes[0];

      let content = "";
      let streamError: string | null = null;
      let deliveredSceneId: string | null = null;
      let aborted = false;
      try {
        await streamAiChat(
          {
            chatId: chatIdRef.current,
            history,
            prompt,
            ...(storeId ? { storeSceneId: storeId } : {}),
            surface: propsRef.current.mode === "new" ? "store-new" : "store",
            ...(targetScene ? { scene: targetScene, sceneId: targetScene.id } : {}),
            ...(editorScenes.length > 0 ? { scenes: editorScenes } : {}),
            ...(draftListing ? { listing: draftListing } : {}),
          },
          {
            onEvent: (event) => {
              switch (event.type) {
                case "chat":
                  if (event.chatId && event.chatId !== chatIdRef.current) {
                    chatIdRef.current = event.chatId;
                    setChatId(event.chatId);
                  }
                  if (event.turnId) {
                    turnIdRef.current = event.turnId;
                  }
                  setStatus(null);
                  break;
                case "ping":
                  break;
                case "delta":
                  content += event.text;
                  updateMessage(assistantId, { content });
                  break;
                case "tool":
                  updateMessage(assistantId, (message) => {
                    const tools = [...(message.tools ?? [])];
                    // The most recent open line for this tool, if any.
                    let openIndex = -1;
                    for (let index = tools.length - 1; index >= 0; index -= 1) {
                      const line = tools[index]!;
                      if (line.name === event.name && isOpen(line)) {
                        openIndex = index;
                        break;
                      }
                    }
                    if (event.status === "progress") {
                      // The model is writing this call's arguments: keep one
                      // line per call and update its byte count.
                      if (openIndex !== -1 && tools[openIndex]!.status === "progress") {
                        tools[openIndex] = { ...tools[openIndex]!, detail: event.detail };
                      } else {
                        tools.push({
                          detail: event.detail,
                          key: `${tools.length}-${event.name}`,
                          label: event.label || event.name,
                          name: event.name,
                          status: "progress",
                        });
                      }
                    } else if (event.status === "start") {
                      if (openIndex !== -1 && tools[openIndex]!.status === "progress") {
                        tools[openIndex] = { ...tools[openIndex]!, detail: undefined, status: "start" };
                      } else {
                        tools.push({
                          key: `${tools.length}-${event.name}`,
                          label: event.label || event.name,
                          name: event.name,
                          status: "start",
                        });
                      }
                    } else if (openIndex !== -1) {
                      tools[openIndex] = { ...tools[openIndex]!, detail: event.detail, status: event.status };
                    }
                    return { tools };
                  });
                  break;
                case "listing":
                  propsRef.current.onListing?.(event.listing);
                  break;
                case "scenes": {
                  const applied = applyScenes(event);
                  const incomingId = event.scenes[0]?.id;
                  deliveredSceneId =
                    (typeof applied === "string" && applied) ||
                    (typeof incomingId === "string" && incomingId) ||
                    (event.tool === "modify_scene" ? (targetScene?.id ?? null) : null);
                  break;
                }
                case "done":
                  break;
                case "error":
                  streamError = event.detail;
                  break;
              }
            },
            onResume: ({ attempt, elapsedMs }) => {
              setStatus(
                `Connection dropped after ${formatElapsed(elapsedMs)} — reconnecting (attempt ${attempt})…`,
              );
            },
            signal: controller.signal,
          },
        );
        setStatus(null);
      } catch (error) {
        setStatus(null);
        if (controller.signal.aborted) {
          aborted = true;
        } else if (error instanceof AiChatTransportError) {
          streamError = error.message;
          posthog.capture("ai_chat_stream_lost", {
            attempts: error.attempts,
            chat_id: chatIdRef.current,
            elapsed_ms: error.elapsedMs,
            had_turn: Boolean(error.turnId),
            turn_id: error.turnId ?? null,
          });
        } else if (error instanceof AiChatRequestError) {
          if (error.code === "login_required") {
            setFatal({ kind: "login_required" });
          } else if (error.code === "missing_api_key") {
            setFatal({ kind: "missing_api_key" });
          } else if (error.code === "ai_disabled") {
            setFatal({ kind: "ai_disabled" });
          } else if (error.code === "daily_cap_reached") {
            setFatal({
              kind: "daily_cap_reached",
              resetAt: error.resetAt ?? null,
              shared: error.allowance === "shared",
            });
          } else if (error.code === "rate_limited" || error.status === 429) {
            setFatal({ kind: "rate_limited" });
          } else {
            setFatal({ kind: "error", message: error.message });
          }
          // A pre-stream failure: drop the empty placeholder, keep the prompt.
          setMessages((current) => current.filter((message) => message.id !== assistantId));
          busyRef.current = false;
          setBusy(false);
          abortRef.current = null;
          return;
        } else {
          streamError = error instanceof Error ? error.message : String(error);
        }
      }
      abortRef.current = null;

      updateMessage(assistantId, {
        content: content || (streamError || aborted ? "" : "Done."),
        error: streamError,
        stopped: aborted,
        streaming: false,
      });

      if (streamError && turnIdRef.current && !aborted) {
        // The turn kept running server-side; when its reply lands in the
        // chat history, swap it in (scene included) so nothing is lost.
        recoveryRef.current = recoverFromHistory({
          apply: (recovered) => {
            updateMessage(assistantId, {
              content: recovered.content,
              error: null,
            });
            if (recovered.scenes) {
              propsRef.current.onScenes({
                scenes: recovered.scenes,
                tool: recovered.tool === "build_scene" ? "build_scene" : "modify_scene",
                type: "scenes",
              });
            }
          },
          chatId: chatIdRef.current,
          since: turnStartedAt,
        });
      }

      if (deliveredSceneId && !streamError && !aborted) {
        // Render the delivered scene once in the wasm preview runtime and
        // hand runtime errors straight back to the agent — a scene that
        // validated as JSON can still fail at render time.
        setStatus("Checking that the scene renders…");
        const { getScenes: readLatest, height: checkHeight, width: checkWidth } = propsRef.current;
        // Kept beside the frame it produces: "Show in preview" runs these
        // exact scenes, whatever the editor holds by then.
        const checkedScenes = readLatest() ?? editorScenes;
        const check = await renderSceneCheck({
          height: checkHeight,
          sceneId: deliveredSceneId,
          scenes: checkedScenes,
          width: checkWidth,
        });
        setStatus(null);
        const uniqueErrors = [...new Set(check.errors)];
        const passed = uniqueErrors.length === 0 && check.rendered;
        const verdict = passed
          ? {
              ok: true,
              text: `Render check passed${check.renderMs !== null ? ` (${(check.renderMs / 1000).toFixed(1)}s)` : ""}`,
            }
          : {
              ok: false,
              text: `Render check found ${uniqueErrors.length || "a render"} problem${uniqueErrors.length === 1 ? "" : "s"}`,
            };
        // The frame is shown even when errors were logged: it is what the
        // panel would display.
        const preview: RenderPreview | null = check.pngDataUrl
          ? {
              height: check.height > 0 ? check.height : checkHeight,
              sceneId: deliveredSceneId,
              scenes: checkedScenes,
              src: check.pngDataUrl,
              width: check.width > 0 ? check.width : checkWidth,
            }
          : null;
        setMessages((current) =>
          withPreview(
            current.map((message) =>
              message.id === assistantId ? { ...message, check: verdict } : message,
            ),
            assistantId,
            preview,
          ),
        );
        if (!passed) {
          if (round < MAX_RENDER_CHECK_ROUNDS) {
            busyRef.current = false;
            setBusy(false);
            await submit(formatCheckFeedback(uniqueErrors, check.rendered), round + 1);
            return;
          }
        }
      }
      busyRef.current = false;
      setBusy(false);
    },
    [aiDisabled, signedIn, updateMessage],
  );

  // The entry points hand over a prompt (?ai=… / ?prompt=…): send it right
  // away when signed in, otherwise leave it in the box for after sign-in.
  const initialPromptRef = useRef(initialPrompt);
  useEffect(() => {
    const prompt = initialPromptRef.current?.trim();
    if (!prompt) {
      return;
    }
    if (signedIn) {
      void submit(prompt);
    } else {
      setInput(prompt);
    }
    // Runs once on mount by design: the prompt is a one-off hand-over.
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      recoveryRef.current?.cancel();
    },
    [],
  );

  function stop() {
    abortRef.current?.abort();
    // The turn runs detached on the server; closing our stream no longer
    // stops it, so say so explicitly.
    if (turnIdRef.current) {
      void stopAiChatTurn(turnIdRef.current);
    }
  }

  function send() {
    const prompt = input.trim();
    if (!prompt || busy) {
      return;
    }
    setInput("");
    void submit(prompt);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const chips = suggestions ?? (mode === "new" ? newSceneSuggestions : existingSceneSuggestions);
  const signInHref = `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}return_to=${encodeURIComponent(returnTo || "/")}`;
  // A composer you can type into and send, that then always fails, is worse
  // than one that is plainly closed. Both the switch and the sign-in gate are
  // known before the first turn, so neither should be discovered by failing.
  const composerBlocked = !signedIn || aiDisabled;
  const placeholder = aiDisabled
    ? "AI features are off for this account"
    : mode === "new"
      ? "Describe the scene, e.g. “A clock with the date underneath, big white text on dark green”"
      : "Ask for a change, e.g. “make the title text bigger”";

  return (
    <section aria-label="AI assistant" className="ai-panel">
      <header className="ai-panel__header">
        <Sparkles aria-hidden size={16} />
        <span>AI assistant</span>
      </header>

      <div className="ai-panel__transcript" ref={transcriptRef}>
        {signedIn && aiDisabled ? (
          <div className="notice ai-panel__notice">
            <strong className="ai-panel__notice-title">
              <Sparkles aria-hidden size={14} />
              AI features are switched off.
            </strong>
            <p className="copy">
              You turned AI off for this account, so nothing here can run — and
              nothing can cost you anything.
            </p>
            {aiSettingsUrl ? (
              <a className="button button--small" href={aiSettingsUrl}>
                Turn AI back on
              </a>
            ) : null}
          </div>
        ) : null}

        {!signedIn ? (
          <div className="notice ai-panel__notice">
            <strong>Sign in to use the AI.</strong>
            <p className="copy">
              The assistant edits the scene in the editor and runs on your own
              OpenAI key.
            </p>
            <a className="button button--small" href={signInHref}>
              Sign in
            </a>
          </div>
        ) : null}

        {messages.length === 0 && signedIn && !fatal ? (
          <div className="ai-panel__empty">
            <p className="copy">
              {mode === "new"
                ? "Describe the scene you want and the assistant builds it in the editor. A few ideas:"
                : "Ask for changes to this scene and the assistant edits it in the editor. A few ideas:"}
            </p>
            <div className="ai-panel__chips">
              {chips.map((chip) => (
                <button
                  className="ai-panel__chip"
                  disabled={busy}
                  key={chip}
                  onClick={() => void submit(chip)}
                  type="button"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            message.auto ? (
              <div className="ai-panel__bubble ai-panel__bubble--auto" key={message.id}>
                <span className="ai-panel__auto-label">Automatic render check</span>
                <pre className="ai-panel__auto-text">
                  {message.content.slice(RENDER_CHECK_PREFIX.length).trim()}
                </pre>
              </div>
            ) : (
              <div className="ai-panel__bubble ai-panel__bubble--user" key={message.id}>
                {message.content}
              </div>
            )
          ) : (
            <div className="ai-panel__bubble ai-panel__bubble--assistant" key={message.id}>
              <ToolActivity streaming={Boolean(message.streaming)} tools={message.tools ?? []} />
              {message.content ? <AssistantMarkdown content={message.content} /> : null}
              {message.streaming && !message.content ? (
                <span className="ai-panel__thinking">
                  <Loader2 aria-hidden className="ai-panel__spin" size={14} />
                  Thinking…
                </span>
              ) : null}
              {message.stopped ? <span className="ai-panel__muted">Stopped.</span> : null}
              {message.error ? (
                <p className="notice notice-error ai-panel__notice" role="alert">
                  {message.error}
                </p>
              ) : null}
              {message.check ? (
                <span
                  className={
                    message.check.ok
                      ? "ai-panel__check ai-panel__check--ok"
                      : "ai-panel__check ai-panel__check--warn"
                  }
                >
                  {message.check.ok ? (
                    <Check aria-hidden size={12} />
                  ) : (
                    <AlertTriangle aria-hidden size={12} />
                  )}
                  {message.check.text}
                </span>
              ) : null}
              {message.preview ? (
                <div className="ai-panel__render-block">
                  <RenderPreviewImage preview={message.preview} />
                  {onShowInPreview ? (
                    <button
                      className="ai-panel__render-open"
                      onClick={() => {
                        const { sceneId: renderedSceneId, scenes } = message.preview!;
                        onShowInPreview({ sceneId: renderedSceneId, scenes });
                      }}
                      type="button"
                    >
                      <Play aria-hidden size={12} />
                      Show in preview
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ),
        )}

        {status ? (
          <div className="ai-panel__status" role="status">
            <Loader2 aria-hidden className="ai-panel__spin" size={14} />
            {status}
          </div>
        ) : null}

        {fatal?.kind === "login_required" ? (
          <div className="notice ai-panel__notice" role="alert">
            Your session has expired. <a href={signInHref}>Sign in again</a> to keep going.
          </div>
        ) : null}
        {fatal?.kind === "missing_api_key" ? (
          <div className="notice ai-panel__notice" role="alert">
            <strong className="ai-panel__notice-title">
              <KeyRound aria-hidden size={14} />
              The AI needs an OpenAI API key.
            </strong>
            <p className="copy">
              The assistant runs on your own key, which is not set yet.
              {settingsUrl ? (
                <>
                  {" "}
                  Add it under{" "}
                  <a href={settingsUrl} rel="noreferrer" target="_blank">
                    Settings → OpenAI → API key for AI chat
                  </a>
                  , then try again.
                </>
              ) : (
                " Add it in your account's settings (OpenAI → API key for AI chat), then try again."
              )}
            </p>
          </div>
        ) : null}
        {fatal?.kind === "ai_disabled" ? (
          <div className="notice ai-panel__notice" role="alert">
            <strong className="ai-panel__notice-title">AI is switched off for this account.</strong>
            <p className="copy">
              Nothing is wrong — it was turned off under Account → AI usage,
              and it can be turned back on there in one click.
            </p>
          </div>
        ) : null}
        {fatal?.kind === "daily_cap_reached" ? (
          <div className="notice ai-panel__notice" role="alert">
            <strong className="ai-panel__notice-title">
              {fatal.shared
                ? "Today\u2019s free AI allowance is used up."
                : "Today\u2019s AI limit is used up."}
            </strong>
            <p className="copy">
              {fatal.shared
                ? "This account runs on the operator\u2019s shared key, so nothing is billed for it \u2014 and the allowance is the operator\u2019s daily budget, not yours. It resets"
                : "The daily limit keeps a runaway loop from costing more than a bounded amount. It resets"}
              {fatal.resetAt ? ` at ${new Date(fatal.resetAt).toLocaleString()}` : " at midnight UTC"}
              ; the reply so far is kept.
              {fatal.shared
                ? " Add your own OpenAI key under Settings to keep going without it."
                : ""}
            </p>
          </div>
        ) : null}
        {fatal?.kind === "rate_limited" ? (
          <p className="notice notice-error ai-panel__notice" role="alert">
            Too many requests — wait a minute and try again.
          </p>
        ) : null}
        {fatal?.kind === "error" ? (
          <p className="notice notice-error ai-panel__notice" role="alert">
            {fatal.message}
          </p>
        ) : null}
      </div>

      <form
        className="ai-panel__composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          aria-label="Message the AI"
          className="ai-panel__input"
          disabled={composerBlocked}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={textareaRef}
          rows={3}
          value={input}
        />
        <div className="ai-panel__composer-row">
          <span className="ai-panel__hint">Enter to send · Shift+Enter for a new line</span>
          {busy ? (
            <button className="button button--small button--subtle" onClick={stop} type="button">
              <Square aria-hidden size={14} />
              Stop
            </button>
          ) : (
            <button
              className="button button--small button-primary"
              disabled={composerBlocked || !input.trim()}
              type="submit"
            >
              <Send aria-hidden size={14} />
              Send
            </button>
          )}
        </div>
        {saveHint ? <p className="ai-panel__save-hint">{saveHint}</p> : null}
      </form>
    </section>
  );
}

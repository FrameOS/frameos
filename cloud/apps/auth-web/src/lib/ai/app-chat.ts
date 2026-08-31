// App-code chat: the Chat panel opened on a scene's JS app node, rather than
// on the scene graph. One Responses call, one optional tool.
//
// The cloud does not host app sources — the SPA sends the whole file map in
// the request (chatLogic's `sources`), the same way it does against the
// self-hosted backend — so this needs no repository access and no storage.
// What it returns is the same shape the backend's /api/ai/apps/chat returns,
// because the SPA is one component talking to both: `{reply, tool, files?}`
// with tool "edit_app" (the panel writes `files` into the editor) or
// "ask_about_app" (reply only).
//
// Two tools, not one, and both explicit: a model that "answers" by pasting a
// rewritten app.ts into prose is the failure this shape prevents — the panel
// only applies what arrives through write_app_files.

import {
  streamResponse,
  type ResponsesToolDefinition,
  type ResponseUsage,
} from "./openai";
import { parseToolArguments } from "./tool-args";

export const maxAppSourceChars = 120_000;
export const maxAppFiles = 40;

export interface AppChatSources {
  [fileName: string]: string;
}

export interface AppChatResult {
  reply: string;
  tool: "ask_about_app" | "ask_about_app_error" | "edit_app";
  files?: AppChatSources;
  // What the call burned, so the route can meter it. One round, always:
  // this panel has no agent loop.
  usage: ResponseUsage;
}

/** Parse and bound the `sources` map. Returns undefined when there is nothing
 *  usable — an app chat without the app's code has nothing to talk about. */
export function readAppSources(value: unknown): AppChatSources | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[0].length > 0 && entry[0].length <= 256,
    )
    .slice(0, maxAppFiles);
  if (entries.length === 0) {
    return undefined;
  }
  let budget = maxAppSourceChars;
  const sources: AppChatSources = {};
  for (const [name, source] of entries) {
    if (budget <= 0) {
      break;
    }
    // Truncate rather than drop: a model that can see most of a long file
    // still answers usefully, and it is told where the cut is.
    sources[name] =
      source.length <= budget
        ? source
        : `${source.slice(0, budget)}\n/* ...truncated by FrameOS Cloud... */`;
    budget -= Math.min(source.length, budget);
  }
  return Object.keys(sources).length > 0 ? sources : undefined;
}

const writeAppFilesTool: ResponsesToolDefinition = {
  description:
    "Write the app's source files back to the user's editor. Send COMPLETE file contents (never a diff, " +
    "never a fragment), and only the files you actually changed. Use this whenever the user asks for a " +
    "change to the app's code or config.",
  name: "write_app_files",
  parameters: {
    additionalProperties: false,
    properties: {
      files: {
        additionalProperties: { type: "string" },
        description:
          "Map of file name to its complete new contents, e.g. {\"app.ts\": \"...\"}. Only changed files.",
        type: "object",
      },
      reply: {
        description: "One or two sentences describing what you changed.",
        type: "string",
      },
    },
    required: ["files", "reply"],
    type: "object",
  },
  type: "function",
};

export function buildAppChatInstructions(): string {
  return `
You are the FrameOS Cloud assistant, helping with the source of ONE app inside a FrameOS scene.

A FrameOS app is a small TypeScript/JavaScript module that runs in QuickJS on the frame itself. Its files
are config.json (name, category, fields, output), app.ts (the entry module the runtime calls), and
optionally helper .ts/.tsx/.js/.jsx and .json files that app.ts imports with relative paths
(import { x } from "./helper", import data from "./data.json"). Apps receive their declared fields as
inputs and either render onto the shared canvas or return a value other nodes consume.

You can do exactly two things:
- Answer questions about this app's code and configuration. Reply in prose; be concrete and quote the
  relevant lines rather than restating the whole file.
- Change the app's code, by calling write_app_files with the COMPLETE new contents of the files you
  changed. Never paste changed code into your reply and never describe a change you did not write through
  the tool — the editor applies the tool call and nothing else.

Rules for edits:
- Keep the existing file layout and the app's declared fields unless the user asks to change them; if you
  change a field, update config.json in the same call.
- The runtime is QuickJS, not Node: no npm packages, no require(), no filesystem, no DOM. Relative
  imports of the app's own files are fine (and you may add a file by writing it through the tool);
  JSX only in .tsx/.jsx. Use the ambient FrameOS helpers already visible in the app's own source.
- Keep it TypeScript-shaped and readable; match the surrounding style.
- If the request is ambiguous, ask one question instead of guessing at a rewrite.

Be concise. Reply in the user's language.
`.trim();
}

function appContextBlock(input: {
  appName: string | null;
  appKeyword: string | null;
  sceneId: string | null;
  nodeId: string | null;
  sources: AppChatSources;
}): string {
  const header = [
    "The user has this app open in the editor:",
    input.appName ? `- Name: ${input.appName}` : null,
    input.appKeyword ? `- Keyword: ${input.appKeyword}` : null,
    input.sceneId ? `- Scene id: ${input.sceneId}` : null,
    input.nodeId ? `- Node id: ${input.nodeId}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const files = Object.entries(input.sources)
    .map(([name, source]) => `--- ${name} ---\n${source}`)
    .join("\n\n");
  return `${header}\n\nIts current files:\n\n${files}`;
}

/** One turn of app chat. Throws on transport failure; the caller maps that to
 *  the error reply the panel renders. */
export async function runAppChat(input: {
  apiKey: string;
  model: string;
  reasoningEffort?: string | undefined;
  prompt: string;
  appName: string | null;
  appKeyword: string | null;
  sceneId: string | null;
  nodeId: string | null;
  sources: AppChatSources;
  history: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal | undefined;
}): Promise<AppChatResult> {
  const result = await streamResponse({
    apiKey: input.apiKey,
    input: [
      ...input.history.map((message) => ({
        content: message.content,
        role: message.role,
        type: "message",
      })),
      {
        content: `${appContextBlock(input)}\n\n${input.prompt}`,
        role: "user",
        type: "message",
      },
    ],
    instructions: buildAppChatInstructions(),
    model: input.model,
    onTextDelta: () => {
      // The panel's contract is a single JSON body, not a stream — it fakes
      // typing client-side. Deltas are aggregated by streamResponse.
    },
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    tools: [writeAppFilesTool],
  });

  const usage = result.usage;
  const call = result.functionCalls.find((entry) => entry.name === "write_app_files");
  if (!call) {
    return { reply: result.outputText.trim() || "Done.", tool: "ask_about_app", usage };
  }

  // App sources are JS, and a model writing JS into a JSON argument is the
  // common way a call comes back with raw newlines in it. parseToolArguments
  // repairs that where it safely can; where it cannot, `files` stays empty and
  // the reply below says the edit did not happen.
  const parsedArgs = parseToolArguments(call.name, call.arguments);
  const parsed = "args" in parsedArgs ? parsedArgs.args : undefined;
  const files = readAppSources(parsed?.files);
  if (!files) {
    // The model meant to edit and produced nothing applicable. Say so rather
    // than reporting a successful edit the editor never received.
    return {
      reply:
        result.outputText.trim() ||
        "I tried to rewrite the app but produced no usable files — say what you want changed and I will try again.",
      tool: "ask_about_app",
      usage,
    };
  }
  const reply =
    (parsed?.reply === undefined ? "" : String(parsed.reply)).trim() ||
    result.outputText.trim() ||
    "Updated app files.";
  return { files, reply, tool: "edit_app", usage };
}

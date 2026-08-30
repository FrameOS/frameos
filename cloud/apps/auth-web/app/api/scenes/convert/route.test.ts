import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelPort, ModelRequest } from "@frameos-cloud/scene-convert";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession } from "../../../../src/lib/session";
import { checkRateLimit } from "../../../../src/lib/rate-limit";
import { openAiModelPort } from "@frameos-cloud/scene-convert";
import { captureSceneConversion } from "../../../../src/lib/ai/telemetry";
import { GET, POST, sharedConverterKey } from "./route";

// The converter's public door: no session needed, the platform key behind
// budgets, a caller's own key ahead of it, and the converted JSON back in
// the shape it came in. The model is a fake; the renderer is "not installed".

vi.mock("../../../../src/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/lib/rate-limit")>("../../../../src/lib/rate-limit");
  return {
    ...actual,
    checkRateLimit: vi.fn(() => Promise.resolve({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 })),
    rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
  };
});
vi.mock("../../../../src/lib/session", () => ({
  readSession: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/scene-render", () => ({
  SceneRenderError: class extends Error {},
  rendererAvailable: () => false,
  renderScenes: vi.fn(),
}));
vi.mock("../../../../src/lib/ai/telemetry", () => ({
  captureSceneConversion: vi.fn(),
}));
vi.mock("@frameos-cloud/scene-convert", async () => {
  const actual = await vi.importActual<typeof import("@frameos-cloud/scene-convert")>("@frameos-cloud/scene-convert");
  return { ...actual, openAiModelPort: vi.fn() };
});

const sessionMock = vi.mocked(readSession);
const rateLimitMock = vi.mocked(checkRateLimit);
const portMock = vi.mocked(openAiModelPort);
const telemetryMock = vi.mocked(captureSceneConversion);

const vannituba = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../../../../../../packages/scene-convert/fixtures/vannituba.json"), "utf8"),
) as Record<string, unknown>;

const heatTimerTs = "export function run(app, context) { frameos.setState('heatTimer', '') }";

function fakePort(answer: unknown): ModelPort & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const port = (async (request: ModelRequest) => {
    requests.push(request);
    return { arguments: answer, model: "fake-model", text: "", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
  }) as ModelPort & { requests: ModelRequest[] };
  port.requests = requests;
  return port;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://scenes.example/api/scenes/convert", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS;
  delete process.env.DATABASE_URL;
  sessionMock.mockResolvedValue(undefined);
  portMock.mockReset();
  rateLimitMock.mockClear();
  telemetryMock.mockClear();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/scenes/convert", () => {
  it("describes itself", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { endpoint: string; shared_model_pass: boolean };
    expect(payload.endpoint).toBe("POST /api/scenes/convert");
    expect(payload.shared_model_pass).toBe(false);
  });
});

describe("POST /api/scenes/convert", () => {
  it("refuses a body with no scene in it", async () => {
    const response = await POST(request({ hello: 1 }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_scenes");
  });

  it("refuses scenes without an id", async () => {
    const response = await POST(request({ scenes: [{ name: "x" }] }));
    expect(response.status).toBe(400);
  });

  it("runs the deterministic pass without any key and reports what the model would get", async () => {
    const response = await POST(request({ scene: vannituba }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      scene: { settings: Record<string, unknown>; nodes: { id: string; data: Record<string, unknown> }[] };
      reports: { needsModel: string[]; modelCalls: number; executionAfter: string }[];
      model: { source: string; calls: number; name: string | null };
      lint: { errors: unknown[] };
      render: unknown;
    };
    expect(payload.ok).toBe(false);
    expect(payload.model).toMatchObject({ calls: 0, name: null, source: "none" });
    expect(payload.reports[0]?.needsModel).toEqual(["dfacd0d4-cb93-4119-ac69-e4f2059add27"]);
    expect(payload.scene.settings.execution).toBe("compiled");
    const code = payload.scene.nodes.find((node) => node.id.startsWith("964cf503"));
    expect(code?.data.codeJS).toBe('stateValue === "heat" ? -40 : 0');
    expect(payload.render).toBeNull();
    expect(portMock).not.toHaveBeenCalled();
    expect(telemetryMock).toHaveBeenCalledWith(expect.objectContaining({ distinctId: "anonymous", keySource: "none", needsModel: 1 }));
  });

  it("uses the platform key for anonymous callers, within its budgets", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    const port = fakePort({ files: { "app.ts": heatTimerTs }, notes: "" });
    portMock.mockReturnValue(port);
    const response = await POST(request({ scenes: [vannituba] }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      scenes: { settings: Record<string, unknown> }[];
      model: { source: string; calls: number; name: string };
      lint: { errors: { message: string }[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.model).toMatchObject({ calls: 1, name: "fake-model", source: "shared" });
    expect(payload.scenes[0]?.settings.execution).toBe("interpreted");
    expect(payload.scenes[0]?.settings.convertedFrom).toMatchObject({ execution: "compiled", tool: "cloud" });
    expect(portMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-platform" }));
    // The model saw the app sandbox's declarations.
    expect(port.requests[0]?.instructions).toContain("declare const frameos");
    // Per-address and global budgets were both consulted.
    const keys = rateLimitMock.mock.calls.map((call) => call[0]);
    expect(keys.some((key) => key.startsWith("scenes:convert-model:") && !key.endsWith(":global"))).toBe(true);
    expect(keys).toContain("scenes:convert-model:global");
    // The converted scene lints clean.
    expect(payload.lint.errors).toEqual([]);
  });

  it("answers 429 when the shared budget is spent, and says what to do", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    rateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 90_000 });
    const response = await POST(request({ scene: vannituba }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    const payload = (await response.json()) as { error: string; hint: string };
    expect(payload.error).toBe("model_budget_exhausted");
    expect(payload.hint).toContain("openaiApiKey");
    expect(portMock).not.toHaveBeenCalled();
  });

  it("prefers the caller's own key and skips the shared budget", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    portMock.mockReturnValue(fakePort({ files: { "app.ts": heatTimerTs }, notes: "" }));
    const response = await POST(request({ openaiApiKey: "sk-mine-0123456789abcdef", scene: vannituba }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { model: { source: string } }).model.source).toBe("request");
    expect(portMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-mine-0123456789abcdef" }));
    expect(rateLimitMock.mock.calls.map((call) => call[0])).not.toContain("scenes:convert-model:global");
  });

  it("rejects an implausible key up front", async () => {
    const response = await POST(request({ openaiApiKey: "short", scene: vannituba }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_openai_key");
  });

  it("does not spend the platform key when the operator turned that off", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    process.env.FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS = "none";
    const response = await POST(request({ scene: vannituba }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { model: { source: string } }).model.source).toBe("none");
    expect(portMock).not.toHaveBeenCalled();
  });

  it("dryRun never touches a key", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    const response = await POST(request({ dryRun: true, scene: vannituba }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { model: { source: string } }).model.source).toBe("none");
    expect(portMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("maps an OpenAI rejection of the caller's key to 400", async () => {
    const { ModelRequestError } = await vi.importActual<typeof import("@frameos-cloud/scene-convert")>("@frameos-cloud/scene-convert");
    portMock.mockReturnValue((async () => {
      throw new ModelRequestError("OpenAI answered 401: bad key", 401);
    }) as ModelPort);
    const response = await POST(request({ openaiApiKey: "sk-mine-0123456789abcdef", scene: vannituba }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_openai_key");
    expect(telemetryMock).toHaveBeenCalledWith(expect.objectContaining({ error: "openai_401" }));
  });

  it("maps any other model failure to 502", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    const { ModelRequestError } = await vi.importActual<typeof import("@frameos-cloud/scene-convert")>("@frameos-cloud/scene-convert");
    portMock.mockReturnValue((async () => {
      throw new ModelRequestError("OpenAI answered 500", 500);
    }) as ModelPort);
    const response = await POST(request({ scene: vannituba }));
    expect(response.status).toBe(502);
  });

  it("keeps the input's shape: a bare array comes back as an array", async () => {
    const response = await POST(request([vannituba]));
    const payload = (await response.json()) as { scenes: unknown[]; scene?: unknown };
    expect(Array.isArray(payload.scenes)).toBe(true);
    expect(payload.scene).toBeUndefined();
  });

  it("only trusts the session cookie on a same-origin request", async () => {
    sessionMock.mockResolvedValue({ accountId: "acc-1", providerIssuer: "frameos-cloud", providerSubject: "me" });
    const foreign = await POST(request({ scene: vannituba }, { origin: "https://evil.example" }));
    expect(foreign.status).toBe(200);
    expect(telemetryMock).toHaveBeenLastCalledWith(expect.objectContaining({ distinctId: "anonymous" }));

    const own = await POST(request({ scene: vannituba }, { origin: "http://localhost:3000" }));
    expect(own.status).toBe(200);
    expect(telemetryMock).toHaveBeenLastCalledWith(expect.objectContaining({ distinctId: "acc-1" }));
  });
});

describe("sharedConverterKey", () => {
  it("is the platform key unless access is none", () => {
    expect(sharedConverterKey({ OPENAI_API_KEY: "sk-x" })).toBe("sk-x");
    expect(sharedConverterKey({ OPENAI_API_KEY: "sk-x", FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS: "none" })).toBeUndefined();
    expect(sharedConverterKey({ OPENAI_API_KEY: "sk-x", FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS: "all" })).toBe("sk-x");
    expect(sharedConverterKey({})).toBeUndefined();
  });
});

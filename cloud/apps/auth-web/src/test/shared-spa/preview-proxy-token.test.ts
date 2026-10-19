// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as packageTokens from "frameos-wasm";
import { FrameOSPreview } from "frameos-wasm";
import * as spaTokens from "../../../../../../frontend/src/utils/previewProxyToken";

// The preview worker authenticates to the HTTP proxy with a short-lived token
// the page mints at `<proxyUrl>/token` (backend and cloud alike), so the
// proxy keeps working for a worker with no cookie and no origin of its own.
// The minting lives twice, in the frameos-wasm package and in the SPA, which
// drives its worker itself: both copies run the same cases here.

const fetchMock = vi.fn<typeof fetch>();

function tokenResponse(token: string, expiresIn = 900) {
  return Response.json({ expiresAt: "", expiresIn, token });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const copies = [
  ["frameos-wasm", packageTokens],
  ["the SPA", spaTokens],
] as const;

describe.each(copies)("proxy tokens (%s)", (_name, tokens) => {
  it("are minted next to the proxy, on its own path", () => {
    const origin = window.location.origin;
    expect(tokens.previewProxyTokenUrl("/api/store/preview-proxy")).toBe(
      `${origin}/api/store/preview-proxy/token`,
    );
    expect(
      tokens.previewProxyTokenUrl("/ingress/x/api/projects/1/frames/2/scene_preview_proxy/"),
    ).toBe(`${origin}/ingress/x/api/projects/1/frames/2/scene_preview_proxy/token`);
    expect(tokens.previewProxyTokenUrl("https://frames.example/p?x=1")).toBe(
      "https://frames.example/p/token?x=1",
    );
  });

  it("mint with the page's credentials and hand back the token", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("t-1", 600));
    expect(await tokens.mintPreviewProxyToken("/api/store/preview-proxy")).toEqual({
      expiresIn: 600,
      token: "t-1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/store\/preview-proxy\/token$/);
    expect(init).toMatchObject({ credentials: "same-origin", method: "POST" });
  });

  it("come back null where there are none to have", async () => {
    expect(await tokens.mintPreviewProxyToken("")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await tokens.mintPreviewProxyToken("/proxy")).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await tokens.mintPreviewProxyToken("/proxy")).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json({ token: "" }));
    expect(await tokens.mintPreviewProxyToken("/proxy")).toBeNull();
  });

  it("are refreshed at two thirds of their life, retried after a failure", async () => {
    vi.useFakeTimers();
    const received: string[] = [];
    const stop = tokens.keepPreviewProxyTokenFresh("/proxy", (token) => received.push(token), {
      expiresIn: 900,
      token: "t-0",
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    await vi.advanceTimersByTimeAsync(599_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);

    fetchMock.mockResolvedValueOnce(tokenResponse("t-1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).toEqual(["t-1"]);

    stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stop asking a server that has no token route", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    const received: string[] = [];
    tokens.keepPreviewProxyTokenFresh("/proxy", (token) => received.push(token));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: Array<Record<string, unknown>> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(readonly url: string | URL) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
}

describe("the worker gets the token", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  it("FrameOSPreview passes a host's own token in init and on setProxyToken", () => {
    const preview = new FrameOSPreview({
      height: 1,
      proxyToken: "t-host",
      proxyUrl: "/proxy",
      scenes: [],
      width: 1,
      workerUrl: "/frameos-wasm/preview-worker.js",
    });
    const worker = FakeWorker.instances[0]!;
    expect(worker.messages[0]).toMatchObject({ proxyToken: "t-host", proxyUrl: "/proxy", type: "init" });
    preview.setProxyToken("t-next");
    expect(worker.messages.at(-1)).toEqual({ token: "t-next", type: "proxyToken" });
    expect(fetchMock).not.toHaveBeenCalled();
    preview.destroy();
  });

  it("FrameOSPreview mints and refreshes with proxyTokens, and stops on destroy", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(tokenResponse("t-1", 900));
    fetchMock.mockResolvedValueOnce(tokenResponse("t-2", 900));
    const preview = new FrameOSPreview({
      height: 1,
      proxyTokens: true,
      proxyUrl: "/api/store/preview-proxy",
      scenes: [],
      width: 1,
      workerUrl: "/frameos-wasm/preview-worker.js",
    });
    const worker = FakeWorker.instances[0]!;
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.messages.filter((message) => message.type === "proxyToken")).toEqual([
      { token: "t-1", type: "proxyToken" },
    ]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(worker.messages.at(-1)).toEqual({ token: "t-2", type: "proxyToken" });
    preview.destroy();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

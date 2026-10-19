// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSceneCheck } from "../../../../../../frontend/src/utils/wasmSceneRenderCheck";

// The SPA drives its own preview workers (the live preview, the fleet tile
// preview, the AI render check): each starts its worker with a token minted
// at `<proxyUrl>/token` (preview-proxy-token.test.ts has the minting). Kept
// apart from that file because wasmSceneRenderCheck's import graph reaches
// framesModel and the legacy workspace components, which this package's
// tsconfig leaves out.

const fetchMock = vi.fn<typeof fetch>();

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
    if (message.type === "init") {
      // A frame right away, so a render check settles.
      queueMicrotask(() =>
        this.onmessage?.({
          data: { buffer: new ArrayBuffer(4), height: 1, renderMs: 1, type: "frame", width: 1 },
        } as MessageEvent),
      );
    }
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
});

describe("the SPA's preview workers", () => {
  it("the SPA's render check starts its worker with a token from the proxy's token route", async () => {
    (window as unknown as { FRAMEOS_APP_CONFIG: unknown }).FRAMEOS_APP_CONFIG = {
      preview_proxy_url: "/api/store/preview-proxy",
    };
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith("/api/store/preview-proxy/token")
        ? Response.json({ expiresAt: "", expiresIn: 900, token: "t-check" })
        : new Response("{}", { status: 404 }),
    );
    const result = await renderSceneCheck(
      { id: 1, height: 1, name: "check", rotate: 0, width: 1 } as never,
      [{ id: "scene-1", name: "Scene", nodes: [], edges: [] } as never],
      "scene-1",
    );
    expect(result.rendered).toBe(true);
    expect(FakeWorker.instances[0]!.messages[0]).toMatchObject({
      proxyToken: "t-check",
      proxyUrl: "/api/store/preview-proxy",
      type: "init",
    });
  });
});

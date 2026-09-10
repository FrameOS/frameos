// The shared SPA's cloud chat client re-attaches to a detached turn after
// the relay drops. The budget is the turn's lifetime, not a handful of
// seconds: a relay that keeps answering 200 and dropping (a proxy cutting
// long responses) is resumed for as long as the turn runs, and only
// consecutive unreachable attempts or the overall budget end it. Pinned
// from auth-web like the other frontend pure modules (frontend/ has no
// test runner).
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", () => ({
  apiFetch: (input: string) => apiFetchMock(input),
}));

import {
  CloudAiChatTransportError,
  RESUME_ATTEMPTS,
  RESUME_BUDGET_MS,
  resumeDelayMs,
  streamCloudAiChat,
  type CloudAiChatEvent,
} from "../../../../../../frontend/src/utils/cloudAiChat";

function ndjson(lines: string[], status = 200): Response {
  return new Response(lines.join(""), {
    headers: { "content-type": "application/x-ndjson" },
    status,
  });
}

const request = { chatId: "c1", frameId: "f1", history: [], prompt: "hi" };

afterEach(() => {
  apiFetchMock.mockReset();
});

describe("streamCloudAiChat resume budget", () => {
  it("covers the cloud's 15 minute turn ceiling and backs off to a 10 s cap", () => {
    expect(RESUME_BUDGET_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(RESUME_ATTEMPTS).toBeGreaterThanOrEqual(20);
    expect([0, 1, 2, 5, 6, 50].map(resumeDelayMs)).toEqual([500, 1500, 3000, 10000, 10000, 10000]);
  });

  it("keeps re-attaching past the attempt cap while the server still relays the turn", async () => {
    let resumes = 0;
    apiFetchMock.mockImplementation(async (url) => {
      if (url === "/api/ai/chat") {
        return ndjson(['{"type":"chat","chatId":"c1","turnId":"t1"}\n']);
      }
      resumes += 1;
      return resumes < 8
        ? ndjson(['{"type":"ping"}\n'])
        : ndjson(['{"type":"done","tool":"reply","reply":"late"}\n']);
    });
    const events: CloudAiChatEvent[] = [];
    const slept: number[] = [];
    await streamCloudAiChat(request, (event) => void events.push(event), {
      resumeAttempts: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(events.map((event) => event.type)).toEqual(["chat", "done"]);
    expect(resumes).toBe(8);
    expect(slept).toEqual(Array(8).fill(500));
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/ai/chat/turns/t1?after=1");
  });

  it("gives up after consecutive unreachable attempts, and when the budget is spent", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      if (url === "/api/ai/chat") {
        return ndjson(['{"type":"chat","chatId":"c1","turnId":"t1"}\n']);
      }
      throw new TypeError("Failed to fetch");
    });
    const slept: number[] = [];
    const capped = await streamCloudAiChat(request, () => {}, {
      resumeAttempts: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).catch((error: unknown) => error);
    expect(capped).toBeInstanceOf(CloudAiChatTransportError);
    expect((capped as CloudAiChatTransportError).turnId).toBe("t1");
    expect(slept).toEqual([500, 1500, 3000]);

    let clock = 0;
    let resumes = 0;
    apiFetchMock.mockImplementation(async (url) => {
      if (url === "/api/ai/chat") {
        return ndjson(['{"type":"chat","chatId":"c1","turnId":"t1"}\n']);
      }
      resumes += 1;
      // One relay that drops, then a network that stays down.
      if (resumes === 1) {
        return ndjson(['{"type":"ping"}\n']);
      }
      throw new TypeError("Failed to fetch");
    });
    const budgeted = await streamCloudAiChat(request, () => {}, {
      now: () => clock,
      resumeAttempts: 1000,
      resumeBudgetMs: 30_000,
      sleep: async (ms) => {
        clock += ms;
      },
    }).catch((error: unknown) => error);
    expect(budgeted).toBeInstanceOf(CloudAiChatTransportError);
    expect((budgeted as CloudAiChatTransportError).elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(resumes).toBeLessThan(20);
  });

  it("stops resuming once the server says the turn is gone", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      if (url === "/api/ai/chat") {
        return ndjson(['{"type":"chat","chatId":"c1","turnId":"t1"}\n']);
      }
      return ndjson(['{"error":"turn_not_found"}'], 404);
    });
    const failure = await streamCloudAiChat(request, () => {}, { sleep: async () => {} }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CloudAiChatTransportError);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});

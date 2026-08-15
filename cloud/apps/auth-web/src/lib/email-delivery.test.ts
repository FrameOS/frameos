import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkEmailDelivery } from "./email";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.POSTMARK_SERVER_TOKEN;
});

describe("checkEmailDelivery", () => {
  it("reports 'not configured' rather than an error without a token", async () => {
    await expect(checkEmailDelivery()).resolves.toMatchObject({
      state: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes for a live Postmark server", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ DeliveryType: "Live", Name: "FrameOS" }), {
        status: 200,
      }),
    );

    await expect(checkEmailDelivery()).resolves.toMatchObject({ state: "ok" });
  });

  it("fails a Sandbox server, which accepts mail and delivers none", async () => {
    // This is the failure mode a presence check cannot see and that looks
    // healthiest from the outside: sends succeed, nothing arrives, and every
    // new signup is silently locked out because login needs a verified email.
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ DeliveryType: "Sandbox", Name: "FrameOS" }),
        { status: 200 },
      ),
    );

    const result = await checkEmailDelivery();
    expect(result.state).toBe("failing");
    expect(result.detail).toContain("Sandbox");
  });

  it("fails a revoked token", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(checkEmailDelivery()).resolves.toMatchObject({
      state: "failing",
    });
  });

  it("never throws when Postmark is unreachable", async () => {
    // The admin panel must render the outage, not 500 on it.
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    fetchMock.mockRejectedValueOnce(new Error("dns failure"));

    await expect(checkEmailDelivery()).resolves.toMatchObject({
      state: "failing",
    });
  });
});

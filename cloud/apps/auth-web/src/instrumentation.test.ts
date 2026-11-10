import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "./instrumentation";

const fetchMock = vi.fn();
const request = {
  headers: { cookie: "session=secret-cookie" },
  method: "POST",
  path: "/v/secret-view-token",
};
const context = {
  renderSource: undefined,
  renderType: undefined,
  revalidateReason: undefined,
  routePath: "/v/[token]",
  routeType: "route",
  routerKind: "App Router",
} as unknown as Parameters<typeof onRequestError>[2];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("onRequestError", () => {
  it("files an uncaught error with the tracker, under the route's pattern", async () => {
    await onRequestError(new Error("Object store PUT failed: 411"), request, context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      event: string;
      properties: Record<string, unknown> & { $exception_list: { value: string }[] };
    };
    expect(body.event).toBe("$exception");
    expect(body.properties.frameos_event).toBe("next.request_error");
    expect(body.properties.$exception_list[0]?.value).toBe("Object store PUT failed: 411");
    expect(body.properties.routePath).toBe("/v/[token]");
    expect(body.properties.method).toBe("POST");
  });

  it("never sends the request's path or its headers", async () => {
    await onRequestError(new Error("boom"), request, context);

    const sent = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(sent).not.toContain("secret-view-token");
    expect(sent).not.toContain("secret-cookie");
  });

  it("leaves the edge runtime alone", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await onRequestError(new Error("boom"), request, context);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

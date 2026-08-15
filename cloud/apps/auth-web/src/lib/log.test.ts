import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExceptionPayload } from "./error-tracking";
import { logInfo, logWarn, reportError } from "./log";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
});

function captureLine(spy: ReturnType<typeof vi.spyOn>) {
  return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

describe("structured logging", () => {
  it("writes one JSON line with the event, level and service", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logInfo("email.not_sent_no_provider", { to: "someone@example.com" });

    expect(captureLine(spy)).toMatchObject({
      event: "email.not_sent_no_provider",
      level: "info",
      service: "auth-web",
      to: "someone@example.com",
    });
  });

  it("redacts fields whose key looks like a credential", () => {
    // The point is that a future call site cannot leak a token by passing a
    // convenient-looking object through, so the check is on the key name and
    // does not depend on anyone remembering to strip anything.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logWarn("test.event", {
      accessToken: "frct_secret",
      apiKey: "sk-secret",
      cookie: "session=abc",
      frameId: "keep-me",
      passwordHash: "scrypt$...",
    });

    expect(captureLine(spy)).toMatchObject({
      accessToken: "[redacted]",
      apiKey: "[redacted]",
      cookie: "[redacted]",
      frameId: "keep-me",
      passwordHash: "[redacted]",
    });
  });
});

describe("reportError", () => {
  it("logs at error level and files the exception with PostHog", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportError("email.verification_send_failed", new Error("Postmark 422"), {
      accountId: "acc-1",
    });

    expect(captureLine(spy)).toMatchObject({
      accountId: "acc-1",
      error: "Postmark 422",
      event: "email.verification_send_failed",
      level: "error",
    });

    // Fire-and-forget: let the microtask that issues it run.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://eu.i.posthog.com/capture/");
    const payload = JSON.parse(String(init.body));
    expect(payload.event).toBe("$exception");
    expect(payload.distinct_id).toBe("acc-1");
  });

  it("stays silent when no PostHog key is configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    reportError("test.event", new Error("boom"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the error tracker itself is down", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("posthog unreachable"));

    // A broken error tracker must not turn a handled error into an unhandled
    // rejection — that would take down the request it was reporting on.
    expect(() => reportError("test.event", new Error("boom"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("buildExceptionPayload", () => {
  it("uses PostHog's $exception_list shape so errors group into issues", () => {
    const payload = buildExceptionPayload("phc_test", {
      error: new TypeError("bad input"),
      event: "frames.enroll_failed",
    });

    expect(payload.event).toBe("$exception");
    expect(payload.properties.$exception_list).toEqual([
      {
        mechanism: { handled: true, synthetic: false },
        type: "TypeError",
        value: "bad input",
      },
    ]);
    expect(payload.properties.frameos_event).toBe("frames.enroll_failed");
  });

  it("falls back to a shared distinct id when no account is known", () => {
    const payload = buildExceptionPayload("phc_test", {
      error: new Error("x"),
      event: "test.event",
    });

    expect(payload.distinct_id).toBe("frameos-cloud-server");
  });

  it("redacts credential-shaped fields on their way to PostHog too", () => {
    const payload = buildExceptionPayload("phc_test", {
      error: new Error("x"),
      event: "test.event",
      fields: { frameId: "f-1", tokenReference: "fc_link_secret" },
    });

    expect(payload.properties).toMatchObject({
      frameId: "f-1",
      tokenReference: "[redacted]",
    });
  });

  it("handles a thrown non-Error without crashing the reporter", () => {
    const payload = buildExceptionPayload("phc_test", {
      error: "just a string",
      event: "test.event",
    });

    expect(payload.properties.$exception_list[0]).toMatchObject({
      type: "string",
      value: "just a string",
    });
  });
});

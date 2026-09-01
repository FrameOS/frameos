// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const optInCapturing = vi.fn();
const optOutCapturing = vi.fn();
const reset = vi.fn();
const setConfig = vi.fn();
vi.mock("posthog-js", () => ({
  default: {
    init,
    opt_in_capturing: optInCapturing,
    opt_out_capturing: optOutCapturing,
    reset,
    set_config: setConfig,
  },
}));

const { PostHogProvider } = await import("./PostHogProvider");
const { AnalyticsConsentBanner } = await import("./AnalyticsConsent");
const { consentCookieName } = await import("../lib/analytics-consent");

function setConsentCookie(value: string) {
  document.cookie = `${consentCookieName}=${value}; path=/`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
});

afterEach(() => {
  cleanup();
  document.cookie = `${consentCookieName}=; path=/; max-age=0`;
  for (const mock of [init, optInCapturing, optOutCapturing, reset, setConfig]) {
    mock.mockReset();
  }
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("analytics consent gating", () => {
  it("initialises PostHog opted out and in memory, before any answer", () => {
    // Under ePrivacy, analytics storage needs opt-in consent, and consent
    // collected after the events have already been sent is not consent. So
    // nothing may be captured and nothing may be persisted until the banner
    // is answered — this is the assertion that keeps that true.
    render(<PostHogProvider>{null}</PostHogProvider>);

    const config = init.mock.calls[0]![1] as Record<string, unknown>;
    expect(config.opt_out_capturing_by_default).toBe(true);
    expect(config.persistence).toBe("memory");
  });

  it("stays opted out when the visitor has not decided", () => {
    render(<PostHogProvider>{null}</PostHogProvider>);

    expect(optInCapturing).not.toHaveBeenCalled();
    expect(optOutCapturing).toHaveBeenCalled();
  });

  it("stays opted out when the visitor declined", () => {
    setConsentCookie("denied");

    render(<PostHogProvider>{null}</PostHogProvider>);

    expect(optInCapturing).not.toHaveBeenCalled();
    expect(optOutCapturing).toHaveBeenCalled();
    // Withdrawal must clear what was already stored, not merely stop new
    // events — otherwise the identifier outlives the withdrawal.
    expect(reset).toHaveBeenCalled();
    expect(setConfig).toHaveBeenCalledWith({ persistence: "memory" });
  });

  it("opts in and enables persistence only once consent is granted", () => {
    setConsentCookie("granted");

    render(<PostHogProvider>{null}</PostHogProvider>);

    expect(optInCapturing).toHaveBeenCalled();
    expect(setConfig).toHaveBeenCalledWith({
      persistence: "localStorage+cookie",
    });
  });

  it("captures browser exceptions, so error tracking needs no second vendor", () => {
    render(<PostHogProvider>{null}</PostHogProvider>);

    const config = init.mock.calls[0]![1] as Record<string, unknown>;
    expect(config.capture_exceptions).toBe(true);
  });

  it("never touches the SDK when no key is configured", () => {
    // .env.example ships the key blank and self-hosted installs run without
    // it. posthog-js refuses an empty token with an unconditional
    // console.error ("PostHog was initialized without a token"), so the
    // provider must not call init — or anything else — at all.
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

    render(<PostHogProvider>{null}</PostHogProvider>);

    expect(init).not.toHaveBeenCalled();
    expect(optInCapturing).not.toHaveBeenCalled();
    expect(optOutCapturing).not.toHaveBeenCalled();
  });
});

describe("consent banner", () => {
  it("asks when there is no stored answer", async () => {
    render(<AnalyticsConsentBanner />);

    expect(await screen.findByRole("button", { name: "Accept" })).toBeTruthy();
    // Refusing must be as easy as accepting (art. 7(3)), which starts with
    // both being a button on the banner rather than a buried settings page.
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("stays out of the way once answered", () => {
    setConsentCookie("denied");

    const { container } = render(<AnalyticsConsentBanner />);

    expect(container.querySelector(".consent-banner")).toBeNull();
  });

  it("records the choice and stops asking", async () => {
    render(<AnalyticsConsentBanner />);

    (await screen.findByRole("button", { name: "Accept" })).click();

    expect(document.cookie).toContain(`${consentCookieName}=granted`);
  });

  it("does not ask at all when no analytics key is configured", () => {
    // No analytics means nothing to consent to; showing the banner anyway
    // would ask visitors about cookies that cannot exist.
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

    const { container } = render(<AnalyticsConsentBanner />);

    expect(container.querySelector(".consent-banner")).toBeNull();
  });
});

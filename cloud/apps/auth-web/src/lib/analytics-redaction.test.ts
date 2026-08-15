import { describe, expect, it } from "vitest";
import {
  isSuppressedUrl,
  REDACTED,
  redactAnalyticsProperties,
  redactEmails,
  redactSensitiveParams,
  sanitizeAnalyticsEvent,
} from "./analytics-redaction";

describe("redactSensitiveParams", () => {
  it("redacts the capability tokens our own routes put in URLs", () => {
    expect(
      redactSensitiveParams("https://cloud.frameos.net/recovery?token=abc123"),
    ).toBe(`https://cloud.frameos.net/recovery?token=${REDACTED}`);
    expect(
      redactSensitiveParams("https://scenes.frameos.net/s/my-scene?share=uuid-1"),
    ).toBe(`https://scenes.frameos.net/s/my-scene?share=${REDACTED}`);
    expect(
      redactSensitiveParams("https://cloud.frameos.net/device?user_code=WDJB-MJHT"),
    ).toBe(`https://cloud.frameos.net/device?user_code=${REDACTED}`);
  });

  it("keeps the parts of the URL that carry no secret", () => {
    expect(
      redactSensitiveParams("/s/my-scene?share=uuid-1&version=3"),
    ).toBe(`/s/my-scene?share=${REDACTED}&version=3`);
  });

  it("catches compound spellings the exact list does not enumerate", () => {
    expect(redactSensitiveParams("?client_secret=x&frameToken=y&nope=z")).toBe(
      `?client_secret=${REDACTED}&frameToken=${REDACTED}&nope=z`,
    );
  });

  it("redacts inside an elements chain, not just bare URLs", () => {
    const chain =
      'a:attr__href="/recovery?token=abc"nth-child="1";div:nth-child="2"';
    expect(redactSensitiveParams(chain)).toBe(
      `a:attr__href="/recovery?token=${REDACTED}"nth-child="1";div:nth-child="2"`,
    );
  });

  it("redacts a token in the fragment as well as the query", () => {
    expect(redactSensitiveParams("/callback#access_token=abc&state=1")).toBe(
      `/callback#access_token=${REDACTED}&state=1`,
    );
  });

  it("leaves ordinary text alone", () => {
    expect(redactSensitiveParams("Scene deployed to the kitchen frame")).toBe(
      "Scene deployed to the kitchen frame",
    );
  });
});

describe("redactEmails", () => {
  it("replaces addresses anywhere in the string", () => {
    expect(redactEmails("Signed in as ada@example.com")).toBe(
      `Signed in as ${REDACTED}`,
    );
  });
});

describe("redactAnalyticsProperties", () => {
  it("redacts nested autocapture properties", () => {
    const properties = {
      $current_url: "https://cloud.frameos.net/verify-email?token=secret-1",
      $elements: [
        { attr__href: "/s/private-scene?share=uuid-9", tag_name: "a" },
        { $el_text: "ada@example.com", tag_name: "span" },
      ],
      $event_type: "click",
    };

    expect(redactAnalyticsProperties(properties)).toEqual({
      $current_url: `https://cloud.frameos.net/verify-email?token=${REDACTED}`,
      $elements: [
        { attr__href: `/s/private-scene?share=${REDACTED}`, tag_name: "a" },
        { $el_text: REDACTED, tag_name: "span" },
      ],
      $event_type: "click",
    });
  });

  it("does not mutate the caller's object", () => {
    const properties = { $current_url: "/recovery?token=abc" };
    redactAnalyticsProperties(properties);
    expect(properties.$current_url).toBe("/recovery?token=abc");
  });

  it("keeps the account's own email on its person profile", () => {
    // UserIdentifier sets these on purpose; redacting them would defeat
    // identify rather than protect anyone.
    const properties = {
      $set: { email: "ada@example.com", name: "Ada Lovelace" },
      $current_url: "/account",
    };
    expect(redactAnalyticsProperties(properties)).toEqual(properties);
  });

  it("still redacts URLs inside person properties", () => {
    expect(
      redactAnalyticsProperties({
        $set: { $initial_current_url: "/recovery?token=abc" },
      }),
    ).toEqual({ $set: { $initial_current_url: `/recovery?token=${REDACTED}` } });
  });

  it("passes non-string values through untouched", () => {
    const properties = { count: 3, nested: { ok: true }, missing: null };
    expect(redactAnalyticsProperties(properties)).toEqual(properties);
  });
});

describe("isSuppressedUrl", () => {
  it("matches the admin surface and everything under it", () => {
    expect(isSuppressedUrl("/admin")).toBe(true);
    expect(isSuppressedUrl("/admin/scenes")).toBe(true);
    expect(isSuppressedUrl("https://cloud.frameos.net/admin/reports?q=ada")).toBe(
      true,
    );
  });

  it("does not match paths that merely start with the same letters", () => {
    expect(isSuppressedUrl("/administrators")).toBe(false);
    expect(isSuppressedUrl("/account")).toBe(false);
    expect(isSuppressedUrl("/s/admin-dashboard-scene")).toBe(false);
  });

  it("ignores non-strings and empty values", () => {
    expect(isSuppressedUrl(undefined)).toBe(false);
    expect(isSuppressedUrl("")).toBe(false);
    expect(isSuppressedUrl(42)).toBe(false);
  });
});

describe("sanitizeAnalyticsEvent", () => {
  it("drops every event from the admin surface", () => {
    for (const event of ["$pageview", "$autocapture", "$web_vitals", "$exception"]) {
      expect(
        sanitizeAnalyticsEvent({
          event,
          properties: { $current_url: "https://cloud.frameos.net/admin/scenes" },
        }),
      ).toBeNull();
    }
  });

  it("drops an admin event identified only by $pathname", () => {
    expect(
      sanitizeAnalyticsEvent({ event: "$pageleave", properties: { $pathname: "/admin" } }),
    ).toBeNull();
  });

  it("keeps events from everywhere else", () => {
    expect(
      sanitizeAnalyticsEvent({
        event: "$pageview",
        properties: { $current_url: "https://cloud.frameos.net/account/frames" },
      }),
    ).not.toBeNull();
  });

  it("redacts the properties of a capture", () => {
    expect(
      sanitizeAnalyticsEvent({
        event: "$pageview",
        properties: { $current_url: "/s/x?share=uuid-1" },
      }),
    ).toEqual({
      event: "$pageview",
      properties: { $current_url: `/s/x?share=${REDACTED}` },
    });
  });

  it("passes through a capture with no properties", () => {
    const data = { event: "$pageview" };
    expect(sanitizeAnalyticsEvent(data)).toBe(data);
  });

  it("drops the event rather than send it unredacted", () => {
    const exploding = {
      event: "$pageview",
      get properties(): Record<string, unknown> {
        throw new Error("boom");
      },
    };
    expect(sanitizeAnalyticsEvent(exploding)).toBeNull();
  });
});

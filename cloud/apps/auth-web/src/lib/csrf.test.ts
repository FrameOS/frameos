import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { csrfResponse } from "./csrf";

const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

afterEach(() => {
  restore("FRAMEOS_CLOUD_APP_URL", originalCloudUrl);
  restore("FRAMEOS_ACCOUNT_APP_URL", originalAccountUrl);
  restore("FRAMEOS_SCENES_APP_URL", originalScenesUrl);
});

describe("csrfResponse", () => {
  it("accepts mutations from both first-party app origins", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    for (const origin of [
      "https://cloud.frameos.net",
      "https://account.frameos.net",
      "https://scenes.frameos.net",
    ]) {
      const request = new NextRequest(`${origin}/api/account/scenes/upload`, {
        headers: { origin },
        method: "POST",
      });
      expect(csrfResponse(request)).toBeUndefined();
    }
  });

  it("exempts requests that carry a personal API token", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    // No Origin at all — a script, not a browser tab.
    const request = new NextRequest("https://cloud.frameos.net/api/frames/x", {
      headers: { authorization: "Bearer fc_api_abcdef" },
      method: "POST",
    });
    expect(csrfResponse(request)).toBeUndefined();
  });

  it("stops read-only tokens before the route does any work", async () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    const request = new NextRequest("https://cloud.frameos.net/api/frames/x", {
      headers: { authorization: "Bearer fc_apiro_abcdef" },
      method: "POST",
    });
    const response = csrfResponse(request);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "read_only_token" });
  });

  it("still demands an origin for other bearer kinds", async () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    const request = new NextRequest("https://cloud.frameos.net/api/frames/x", {
      headers: { authorization: "Bearer fc_link_abcdef" },
      method: "POST",
    });
    const response = csrfResponse(request);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "missing_origin" });
  });

  it("rejects other origins", async () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    const request = new NextRequest(
      "https://scenes.frameos.net/api/account/scenes/upload",
      { headers: { origin: "https://evil.example" }, method: "POST" },
    );

    const response = csrfResponse(request);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "invalid_origin" });
  });
});

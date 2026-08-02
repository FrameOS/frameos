// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

// Opening /frames used to fire three requests the cloud cannot serve —
// /api/apps, /api/fonts, /api/templates are self-hosted-backend surfaces —
// so every page load logged three 404s and three "Failed to fetch …" errors
// on the way to fallbacks the callers already had.

describe("cloud mode backend catalogs", () => {
  let apiFetch: typeof import("../../../../../../frontend/src/utils/apiFetch").apiFetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as Record<string, unknown>).FRAMEOS_APP_CONFIG = {
      cloudMode: true,
      ingress_path: "",
    };
    ({ apiFetch } = await import(
      "../../../../../../frontend/src/utils/apiFetch"
    ));
  });

  it("answers the backend-only catalogs locally, in the shape each loader expects", async () => {
    const apps = await apiFetch("/api/apps");
    expect(apps.status).toBe(200);
    expect(await apps.json()).toEqual({ apps: {} });

    const fonts = await apiFetch("/api/fonts");
    expect(await fonts.json()).toEqual({ fonts: [] });

    const templates = await apiFetch("/api/templates");
    expect(await templates.json()).toEqual([]);

    const settings = await apiFetch("/api/settings");
    expect(await settings.json()).toEqual({});

    const assets = await apiFetch("/api/assets");
    expect(await assets.json()).toEqual([]);

    // The backend's own cloud-link status: inside the cloud there is no link
    // to report on, so the shape is a permanent "disabled, disconnected".
    const cloudStatus = await apiFetch("/api/cloud/status");
    expect(await cloudStatus.json()).toEqual({
      can_edit_provider: false,
      connection: null,
      default_provider_url: null,
      enabled: false,
      link: null,
      poll_error: null,
      provider_url: null,
      status: "disconnected",
    });

    // No request reached the network: that is the whole point.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends writes and sub-paths to the network", async () => {
    // Faking success for an import would silently swallow it.
    await apiFetch("/api/templates", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Only the exact catalog paths are answered locally.
    await apiFetch("/api/templates/abc/image");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the cloud's own endpoints alone", async () => {
    await apiFetch("/api/frames");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

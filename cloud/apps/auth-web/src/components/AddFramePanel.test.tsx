// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddFramePanel } from "./AddFramePanel";

// The panel keeps its open state in the URL so Back/Forward move in and out
// of it; these tests pin that contract against the navigation hooks.
const push = vi.fn();
let currentParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/account/frames",
  useRouter: () => ({ push }),
  useSearchParams: () => currentParams,
}));

vi.mock("./SdImageBuilder", () => ({
  SdImageBuilder: () => <div data-testid="sd-builder" />,
}));
vi.mock("./Esp32CloudFlasher", () => ({
  Esp32CloudFlasher: () => <div data-testid="esp32-flasher" />,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({
      claim_token: "FRCT_from_server",
      expires_at: "2030-01-01T00:00:00Z",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  currentParams = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddFramePanel", () => {
  it("stays closed without the URL flag and opens by navigating", () => {
    render(<AddFramePanel />);

    expect(screen.queryByText(/Add a frame/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /add frame/i }));

    expect(push).toHaveBeenCalledWith("/account/frames?add=frame", {
      scroll: false,
    });
    // Nothing opened locally: the URL is the single source of truth, so a
    // Back that removes the param closes the panel without extra state.
    expect(screen.queryByText(/Add a frame/)).toBeNull();
  });

  it("renders open when the URL carries the flag, and mints one code", async () => {
    currentParams = new URLSearchParams("add=frame");
    render(<AddFramePanel />);

    expect(screen.getByText("Add a frame")).toBeDefined();
    // The install command is complete without the user handling codes.
    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=FRCT_from_server/);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/frames/claim-tokens"),
      ),
    ).toHaveLength(1);
    // No raw claim code is presented as something to copy by hand.
    expect(screen.queryByText(/paste this one-time code/i)).toBeNull();
  });

  it("closes by dropping the flag while keeping other query params", () => {
    currentParams = new URLSearchParams("revoked=1&add=frame");
    render(<AddFramePanel />);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(push).toHaveBeenCalledWith("/account/frames?revoked=1", {
      scroll: false,
    });
  });
});

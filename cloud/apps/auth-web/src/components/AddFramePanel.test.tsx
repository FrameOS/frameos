// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
    render(<AddFramePanel claimTokenTtlHours={24} />);

    expect(screen.queryByText(/Add a frame/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /add frame/i }));

    expect(push).toHaveBeenCalledWith("/account/frames?add=frame", {
      scroll: false,
    });
    // Nothing opened locally: the URL is the single source of truth, so a
    // Back that removes the param closes the panel without extra state.
    expect(screen.queryByText(/Add a frame/)).toBeNull();
  });

  // Regression: the panel used to mint a single-use code on every open.
  // Nothing revokes an unused code, the account holds only a few at a time,
  // and Back/Forward reopens the panel — so ~20 open/close cycles burned the
  // whole quota for 24 hours.
  it("mints nothing when the panel opens", async () => {
    currentParams = new URLSearchParams("add=frame");
    render(<AddFramePanel claimTokenTtlHours={24} />);

    expect(screen.getByText("Add a frame")).toBeDefined();
    // The command is shown with the code masked, so it is clear what will run.
    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=<claim code>/);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/frames/claim-tokens"),
      ),
    ).toHaveLength(0);
  });

  it("mints one code when the user asks for the install command", async () => {
    currentParams = new URLSearchParams("add=frame");
    render(<AddFramePanel claimTokenTtlHours={24} />);

    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=FRCT_from_server/);
    const minted = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/frames/claim-tokens"),
    );
    expect(minted).toHaveLength(1);
    // The code becomes copyable; no raw claim code to transcribe by hand.
    expect(screen.getByRole("button", { name: /copy command/i })).toBeDefined();
    expect(screen.queryByText(/paste this one-time code/i)).toBeNull();
  });

  it("explains a claim-code quota rejection instead of blaming the frame limit", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "claim_token_quota_exceeded" }, { status: 403 }),
    );
    currentParams = new URLSearchParams("add=frame");
    render(<AddFramePanel claimTokenTtlHours={24} />);

    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    const alert = await screen.findByRole("alert");
    // Unused single-use codes recycle automatically, so this error can only
    // mean the cap is full of SD-image codes — say that, not "wait 24 hours".
    expect(alert.textContent).toContain("SD-card image");
    expect(alert.textContent).not.toContain("frame limit");
  });

  it("names the frame limit when that is what was hit", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "frame_quota_exceeded" }, { status: 403 }),
    );
    currentParams = new URLSearchParams("add=frame");
    render(<AddFramePanel claimTokenTtlHours={24} />);

    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("frame limit");
  });

  // A code that arrives after the panel closed belongs to the closed panel:
  // letting it land would overwrite whatever the reopened panel holds.
  it("drops a mint that was still in flight when the panel closed", async () => {
    let deliver: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    currentParams = new URLSearchParams("add=frame");
    const view = render(<AddFramePanel claimTokenTtlHours={24} />);
    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    // Back closes the panel, then Forward reopens it.
    currentParams = new URLSearchParams();
    view.rerender(<AddFramePanel claimTokenTtlHours={24} />);
    currentParams = new URLSearchParams("add=frame");
    view.rerender(<AddFramePanel claimTokenTtlHours={24} />);
    await act(async () => {
      deliver?.(Response.json({ claim_token: "FRCT_stale" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(/FRCT_stale/)).toBeNull();
    expect(
      screen.getByText(/FRAMEOS_CLAIM_TOKEN=<claim code>/),
    ).toBeDefined();
  });

  it("closes by dropping the flag while keeping other query params", () => {
    currentParams = new URLSearchParams("revoked=1&add=frame");
    render(<AddFramePanel claimTokenTtlHours={24} />);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(push).toHaveBeenCalledWith("/account/frames?revoked=1", {
      scroll: false,
    });
  });
});
